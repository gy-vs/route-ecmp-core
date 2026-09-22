export type Route<V>={network:Uint8Array,prefix:number,value:V};
export class RouteTable<V>{
  #routes:Route<V>[]=[];
  add(route:Route<V>){this.#routes.push(route)}
  lookup(address:Uint8Array){return this.#routes.filter(route=>matches(route,address)).sort((a,b)=>b.prefix-a.prefix)[0]?.value}
}
function matches<V>(route:Route<V>,address:Uint8Array){for(let bit=0;bit<route.prefix;bit++){const mask=128>>(bit%8);if((route.network[bit>>3]&mask)!==(address[bit>>3]&mask))return false}return true}

export type NextHop={id:string,weight:number,healthy?:boolean};
export type NextHopGroupOptions={slotsPerWeight?:number,maxSlots?:number,hash?:(data:Uint8Array)=>number};

const encoder=new TextEncoder();

export function murmur3(data:Uint8Array,seed=0):number{
  let h1=seed>>>0;
  const c1=0xcc9e2d51,c2=0x1b873593,length=data.length,nblocks=length>>>2;
  for(let i=0;i<nblocks;i++){
    let k1=data[i*4]|(data[i*4+1]<<8)|(data[i*4+2]<<16)|(data[i*4+3]<<24);
    k1=Math.imul(k1,c1);k1=(k1<<15)|(k1>>>17);k1=Math.imul(k1,c2);
    h1^=k1;h1=(h1<<13)|(h1>>>19);h1=(Math.imul(h1,5)+0xe6546b64)|0;
  }
  let k1=0;
  const tail=nblocks*4;
  switch(length&3){
    case 3:k1^=data[tail+2]<<16;
    case 2:k1^=data[tail+1]<<8;
    case 1:k1^=data[tail];k1=Math.imul(k1,c1);k1=(k1<<15)|(k1>>>17);k1=Math.imul(k1,c2);h1^=k1;
  }
  h1^=length;
  h1^=h1>>>16;h1=Math.imul(h1,0x85ebca6b);h1^=h1>>>13;h1=Math.imul(h1,0xc2b2ae35);h1^=h1>>>16;
  return h1>>>0;
}

// Weighted consistent-hash ring: each next hop owns integer slots proportional to
// its weight, so reordering the config is a no-op and add/remove only moves the
// arcs owned by the affected node.
export class NextHopGroup{
  #nodes:{id:string,weight:number,healthy:boolean}[]=[];
  #ring:{position:number,node:number}[]=[];
  #revision=0;
  #slotsPerWeight:number;
  #maxSlots:number;
  #hash:(data:Uint8Array)=>number;
  constructor(nextHops:NextHop[]=[],options:NextHopGroupOptions={}){
    this.#slotsPerWeight=options.slotsPerWeight??4096;
    this.#maxSlots=options.maxSlots??1<<17;
    this.#hash=options.hash??(data=>murmur3(data));
    if(nextHops.length)this.set(nextHops);
  }
  get revision(){return this.#revision}
  get size(){return this.#ring.length}
  get nextHops():NextHop[]{return this.#nodes.map(node=>({...node}))}
  set(nextHops:NextHop[]){
    const seen=new Set<string>();
    for(const hop of nextHops){
      if(seen.has(hop.id))throw new Error(`duplicate next hop id: ${hop.id}`);
      seen.add(hop.id);
      if(!Number.isFinite(hop.weight)||hop.weight<=0)throw new Error(`invalid weight for ${hop.id}: ${hop.weight}`);
    }
    this.#nodes=nextHops.map(hop=>({id:hop.id,weight:hop.weight,healthy:hop.healthy??true})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    this.#revision++;
    this.#rebuild();
  }
  setHealthy(id:string,healthy:boolean){
    const node=this.#nodes.find(node=>node.id===id);
    if(!node)throw new Error(`unknown next hop id: ${id}`);
    node.healthy=healthy;
  }
  select(flowKey:string|Uint8Array):NextHop|undefined{
    const ring=this.#ring,nodes=this.#nodes;
    if(!ring.length)return undefined;
    const healthy=nodes.map(node=>node.healthy);
    if(!healthy.includes(true))return undefined;
    const position=this.#hash(typeof flowKey==='string'?encoder.encode(flowKey):flowKey)>>>0;
    let lo=0,hi=ring.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(ring[mid].position<position)lo=mid+1;else hi=mid}
    if(lo===ring.length)lo=0;
    for(let scanned=0;scanned<ring.length;scanned++){
      const point=ring[lo];
      if(healthy[point.node])return{id:nodes[point.node].id,weight:nodes[point.node].weight,healthy:true};
      lo=(lo+1)%ring.length;
    }
    return undefined;
  }
  #rebuild(){
    const nodes=this.#nodes;
    if(!nodes.length){this.#ring=[];return}
    // Integer slot space: every share maps to a ring point, every node keeps at
    // least one share, so no empty slots and no node is rounded away.
    let shares=nodes.map(node=>Math.max(1,Math.round(node.weight*this.#slotsPerWeight)));
    if(shares.reduce((sum,share)=>sum+share,0)>this.#maxSlots){
      const totalWeight=nodes.reduce((sum,node)=>sum+node.weight,0);
      shares=nodes.map(node=>Math.max(1,Math.round(node.weight/totalWeight*this.#maxSlots)));
    }
    const ring:{position:number,node:number}[]=[];
    for(let node=0;node<nodes.length;node++)
      for(let slot=0;slot<shares[node];slot++)
        ring.push({position:this.#hash(encoder.encode(`${nodes[node].id}#${slot}`))>>>0,node});
    ring.sort((a,b)=>a.position-b.position||a.node-b.node);
    this.#ring=ring;
  }
}

export class EcmpRouteTable{
  #table=new RouteTable<NextHopGroup>();
  #options:NextHopGroupOptions;
  constructor(options:NextHopGroupOptions={}){this.#options=options}
  add(route:{network:Uint8Array,prefix:number,nextHops:NextHop[]}):NextHopGroup{
    const group=new NextHopGroup(route.nextHops,this.#options);
    this.#table.add({network:route.network,prefix:route.prefix,value:group});
    return group;
  }
  group(address:Uint8Array){return this.#table.lookup(address)}
  lookup(address:Uint8Array,flowKey:string|Uint8Array):NextHop|undefined{
    return this.#table.lookup(address)?.select(flowKey);
  }
}
