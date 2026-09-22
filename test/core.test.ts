import{expect,it,describe}from'vitest';
import{RouteTable,NextHopGroup,EcmpRouteTable,murmur3}from'../src/index.js';

it('matches',()=>{const x=new RouteTable<string>();x.add({network:Uint8Array.from([10]),prefix:8,value:'a'});expect(x.lookup(Uint8Array.from([10]))).toBe('a')});

const hops=(...weights:number[])=>weights.map((weight,i)=>({id:`n${i}`,weight}));
const keys=(n:number)=>Array.from({length:n},(_,i)=>`flow-${i}`);
const countsById=(group:NextHopGroup,samples:string[])=>{
  const counts=new Map<string,number>();
  for(const key of samples){const hop=group.select(key);expect(hop).toBeDefined();counts.set(hop!.id,(counts.get(hop!.id)??0)+1)}
  return counts;
};

describe('weighted selection',()=>{
  it('splits equal weights evenly and reproduces per key',()=>{
    const group=new NextHopGroup(hops(1,1,1));
    const samples=keys(100_000);
    const counts=countsById(group,samples);
    for(const id of['n0','n1','n2'])expect(Math.abs(counts.get(id)!/samples.length-1/3)).toBeLessThan(0.02);
    expect(group.select('flow-42')).toEqual(group.select('flow-42'));
    const replica=new NextHopGroup(hops(1,1,1));
    for(const key of keys(1000))expect(replica.select(key)?.id).toBe(group.select(key)?.id);
  });

  it('distributes large samples close to weights',()=>{
    const group=new NextHopGroup(hops(5,3,2));
    const samples=keys(100_000);
    const counts=countsById(group,samples);
    const expected:[string,number][]=[['n0',0.5],['n1',0.3],['n2',0.2]];
    for(const[id,p]of expected)expect(Math.abs(counts.get(id)!/samples.length-p)).toBeLessThan(0.02);
  });

  it('keeps extreme weights reachable without empty slots',()=>{
    const group=new NextHopGroup(hops(1000,1));
    const counts=countsById(group,keys(100_000));
    const tiny=counts.get('n1')!;
    expect(tiny).toBeGreaterThan(0);
    expect(tiny).toBeLessThan(2_000);
    expect(counts.get('n0')!).toBeGreaterThan(98_000);
  });

  it('maps weights into an integer slot space with no empty slots',()=>{
    const group=new NextHopGroup([{id:'a',weight:2},{id:'b',weight:1}],{slotsPerWeight:8});
    expect(group.size).toBe(24);
    const clamped=new NextHopGroup([{id:'a',weight:0.001},{id:'b',weight:0.002}],{slotsPerWeight:1});
    expect(clamped.size).toBe(2);
    for(const key of keys(1000))expect(clamped.select(key)?.id).toMatch(/^[ab]$/);
    const dominated=new NextHopGroup([{id:'a',weight:0.001},{id:'b',weight:1000}],{slotsPerWeight:1});
    expect(dominated.size).toBe(1001);
  });

  it('rejects invalid configuration',()=>{
    expect(()=>new NextHopGroup([{id:'a',weight:1},{id:'a',weight:1}])).toThrow(/duplicate/);
    expect(()=>new NextHopGroup([{id:'a',weight:0}])).toThrow(/invalid weight/);
    expect(()=>new NextHopGroup([{id:'a',weight:Number.NaN}])).toThrow(/invalid weight/);
    expect(new NextHopGroup().select('anything')).toBeUndefined();
    expect(()=>new NextHopGroup(hops(1)).setHealthy('nope',false)).toThrow(/unknown/);
  });
});

describe('stability',()=>{
  it('is invariant to next hop reordering',()=>{
    const a=new NextHopGroup([{id:'x',weight:1},{id:'y',weight:2},{id:'z',weight:3}]);
    const b=new NextHopGroup([{id:'z',weight:3},{id:'x',weight:1},{id:'y',weight:2}]);
    expect(b.size).toBe(a.size);
    for(const key of keys(5000))expect(b.select(key)?.id).toBe(a.select(key)?.id);
  });

  it('migrates only the flows of a node that goes down, and restores on recovery',()=>{
    const group=new NextHopGroup(hops(1,1,1));
    const before=new Map(keys(20_000).map(key=>[key,group.select(key)!.id]));
    group.setHealthy('n1',false);
    for(const[key,id]of before){
      const now=group.select(key)!.id;
      if(id==='n1')expect(now).not.toBe('n1');
      else expect(now).toBe(id);
    }
    group.setHealthy('n1',true);
    for(const[key,id]of before)expect(group.select(key)!.id).toBe(id);
  });

  it('returns no path when every next hop is unhealthy',()=>{
    const group=new NextHopGroup(hops(1,1,1));
    for(const id of['n0','n1','n2'])group.setHealthy(id,false);
    expect(group.select('anything')).toBeUndefined();
    const table=new EcmpRouteTable();
    const inner=table.add({network:Uint8Array.from([10]),prefix:8,nextHops:hops(1,1)});
    inner.setHealthy('n0',false);inner.setHealthy('n1',false);
    expect(table.lookup(Uint8Array.from([10]),'flow')).toBeUndefined();
  });

  it('freezes one health snapshot per lookup',()=>{
    let arm=false;
    const group=new NextHopGroup(hops(1,1),{hash:data=>{if(arm)group.setHealthy('n0',false);return murmur3(data)}});
    let key='';
    for(let i=0;;i++)if(group.select(`k${i}`)!.id==='n0'){key=`k${i}`;break}
    arm=true;
    expect(group.select(key)!.id).toBe('n0');
    expect(group.select(key)!.id).toBe('n1');
  });

  it('keeps colliding flow keys consistent',()=>{
    const group=new NextHopGroup(hops(1,1,1),{hash:()=>0xdeadbeef});
    const chosen=group.select('alpha')!;
    for(const key of['beta','gamma','delta','epsilon'])expect(group.select(key)!.id).toBe(chosen.id);
    group.setHealthy(chosen.id,false);
    const fallback=group.select('alpha')!;
    expect(fallback.id).not.toBe(chosen.id);
    for(const key of['beta','gamma','delta'])expect(group.select(key)!.id).toBe(fallback.id);
    for(const id of['n0','n1','n2'])if(id!==chosen.id&&id!==fallback.id)group.setHealthy(id,false);
    group.setHealthy(fallback.id,false);
    expect(group.select('alpha')).toBeUndefined();
  });
});

describe('revision updates',()=>{
  it('bumps revision on config changes but not on health changes',()=>{
    const group=new NextHopGroup(hops(1,2,3));
    expect(group.revision).toBe(1);
    group.setHealthy('n0',false);
    expect(group.revision).toBe(1);
    group.set([{id:'n2',weight:3},{id:'n0',weight:1},{id:'n1',weight:2}]);
    expect(group.revision).toBe(2);
  });

  it('keeps selections identical when a revision only reorders members',()=>{
    const group=new NextHopGroup(hops(1,2,3));
    const before=new Map(keys(5000).map(key=>[key,group.select(key)!.id]));
    group.set([{id:'n2',weight:3},{id:'n0',weight:1},{id:'n1',weight:2}]);
    for(const[key,id]of before)expect(group.select(key)!.id).toBe(id);
  });

  it('migrates only the removed node\'s flows on removal',()=>{
    const group=new NextHopGroup(hops(1,2,3));
    const before=new Map(keys(20_000).map(key=>[key,group.select(key)!.id]));
    group.set([{id:'n0',weight:1},{id:'n1',weight:2}]);
    expect(group.revision).toBe(2);
    for(const[key,id]of before){
      const now=group.select(key)!.id;
      if(id==='n2')expect(now).not.toBe('n2');
      else expect(now).toBe(id);
    }
  });

  it('migrates only flows that land on an added node',()=>{
    const group=new NextHopGroup(hops(1,2));
    const before=new Map(keys(20_000).map(key=>[key,group.select(key)!.id]));
    group.set([{id:'n0',weight:1},{id:'n1',weight:2},{id:'n2',weight:3}]);
    for(const[key,id]of before){
      const now=group.select(key)!.id;
      if(now!=='n2')expect(now).toBe(id);
    }
  });
});

describe('EcmpRouteTable',()=>{
  it('longest-prefix matches then selects a stable next hop per flow key',()=>{
    const table=new EcmpRouteTable();
    table.add({network:Uint8Array.from([10]),prefix:8,nextHops:hops(1,1)});
    table.add({network:Uint8Array.from([10,1]),prefix:16,nextHops:[{id:'specific',weight:1}]});
    expect(table.lookup(Uint8Array.from([10,1,2,3]),'flow')?.id).toBe('specific');
    const picked=table.lookup(Uint8Array.from([10,2,3,4]),'flow')?.id;
    expect(picked).toMatch(/^n[01]$/);
    expect(table.lookup(Uint8Array.from([10,2,3,4]),'flow')?.id).toBe(picked);
    expect(table.lookup(Uint8Array.from([10,2,3,4]),'other-flow')?.id).toMatch(/^n[01]$/);
    expect(table.lookup(Uint8Array.from([11]),'flow')).toBeUndefined();
  });
});
