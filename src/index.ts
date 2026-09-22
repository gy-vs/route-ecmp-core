export type Route<V>={network:Uint8Array,prefix:number,value:V};
export class RouteTable<V>{#routes:Route<V>[]=[];add(route:Route<V>){this.#routes.push(route)}lookup(address:Uint8Array){return this.#routes.filter(route=>matches(route,address)).sort((a,b)=>b.prefix-a.prefix)[0]?.value}}
function matches<V>(route:Route<V>,address:Uint8Array){for(let bit=0;bit<route.prefix;bit++){const mask=128>>(bit%8);if((route.network[bit>>3]&mask)!==(address[bit>>3]&mask))return false}return true}

export type NextHop={id:string,weight:number,healthy:boolean};

const SLOT_SCALE=8,MAX_SLOTS=4096;

function mix(x:number){x=Math.imul(x^x>>>16,2246822507);x=Math.imul(x^x>>>13,3266489909);return(x^x>>>16)>>>0}

export function hashFlowKey(key:Uint8Array){let h=2166136261;for(const b of key){h^=b;h=Math.imul(h,16777619)}return mix(h)}

function hashId(id:string){let h=2166136261;for(let i=0;i<id.length;i++){h^=id.charCodeAt(i);h=Math.imul(h,16777619)}return mix(h)}

function slotCount(weight:number){return weight>0&&Number.isFinite(weight)?Math.max(1,Math.round(weight*SLOT_SCALE)):0}

type Entry={hop:NextHop,seeds:Uint32Array};

export class HopGroup{
  #entries:Entry[]=[];
  #revision:number;
  constructor(hops:NextHop[]=[],revision=0){this.#revision=revision;this.#build(hops)}
  get revision(){return this.#revision}
  get hops(){return this.#entries.map(e=>e.hop)}
  update(hops:NextHop[],revision=this.#revision+1){this.#revision=revision;this.#build(hops)}
  #build(hops:NextHop[]){
    let counts=hops.map(h=>slotCount(h.weight));
    const total=counts.reduce((a,b)=>a+b,0);
    if(total>MAX_SLOTS)counts=counts.map(c=>c>0?Math.max(1,Math.floor(c*MAX_SLOTS/total)):0);
    this.#entries=hops.map((hop,i)=>{
      const seeds=new Uint32Array(counts[i]),base=hashId(hop.id);
      for(let s=0;s<counts[i];s++)seeds[s]=mix(base^mix(s+1));
      return{hop,seeds};
    });
  }
  pick(key:Uint8Array):NextHop|undefined{
    const live=this.#entries.filter(e=>e.hop.healthy&&e.seeds.length>0);
    if(live.length===0)return undefined;
    const kh=hashFlowKey(key);
    let best:Entry|undefined,score=0,seed=0;
    for(const e of live)for(let i=0;i<e.seeds.length;i++){
      const sd=e.seeds[i],sc=mix(sd^kh);
      if(!best||sc>score||(sc===score&&(sd>seed||(sd===seed&&e.hop.id<best.hop.id)))){best=e;score=sc;seed=sd}
    }
    return best?.hop;
  }
}

export class EcmpTable{
  #table=new RouteTable<HopGroup>();
  add(network:Uint8Array,prefix:number,group:HopGroup){this.#table.add({network,prefix,value:group})}
  lookup(address:Uint8Array,flowKey:Uint8Array){return this.#table.lookup(address)?.pick(flowKey)}
}
