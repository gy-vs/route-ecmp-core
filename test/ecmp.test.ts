import{expect,it}from'vitest';
import{EcmpTable,HopGroup,hashFlowKey,NextHop}from'../src/index.js';

const key=(n:number)=>Uint8Array.from([n&255,n>>>8&255,n>>>16&255,n>>>24]);
const hop=(id:string,weight=1,healthy=true):NextHop=>({id,weight,healthy});
const picks=(g:HopGroup,n:number)=>(Array.from({length:n},(_,i)=>g.pick(key(i))?.id));

it('distributes equal weights evenly',()=>{
  const g=new HopGroup([hop('a'),hop('b'),hop('c')]);
  const n=30000,c:Record<string,number>={a:0,b:0,c:0};
  for(let i=0;i<n;i++)c[g.pick(key(i))!.id]!++;
  for(const id of['a','b','c']){expect(c[id]!/n).toBeGreaterThan(1/3-0.03);expect(c[id]!/n).toBeLessThan(1/3+0.03)}
});

it('distributes proportionally to weights 1:2:3',()=>{
  const g=new HopGroup([hop('a',1),hop('b',2),hop('c',3)]);
  const n=60000,c:Record<string,number>={a:0,b:0,c:0};
  for(let i=0;i<n;i++)c[g.pick(key(i))!.id]!++;
  expect(c.a!/n).toBeGreaterThan(1/6-0.02);expect(c.a!/n).toBeLessThan(1/6+0.02);
  expect(c.b!/n).toBeGreaterThan(1/3-0.02);expect(c.b!/n).toBeLessThan(1/3+0.02);
  expect(c.c!/n).toBeGreaterThan(1/2-0.02);expect(c.c!/n).toBeLessThan(1/2+0.02);
});

it('handles extreme weights: 1 vs 500',()=>{
  const g=new HopGroup([hop('light',1),hop('heavy',500)]);
  const n=10000;let light=0;
  for(let i=0;i<n;i++)if(g.pick(key(i))!.id==='light')light++;
  expect(light).toBeGreaterThan(0);
  expect(light/n).toBeLessThan(0.01);
});

it('integer slots never leave a positive weight empty',()=>{
  const g=new HopGroup([hop('tiny',0.0001),hop('a'),hop('b')]);
  let tiny=0;for(let i=0;i<20000;i++)if(g.pick(key(i))!.id==='tiny')tiny++;
  expect(tiny).toBeGreaterThan(0);
});

it('never picks a zero weight hop',()=>{
  const g=new HopGroup([hop('zero',0),hop('a')]);
  for(let i=0;i<1000;i++)expect(g.pick(key(i))!.id).toBe('a');
});

it('is independent of next hop order',()=>{
  const a=new HopGroup([hop('a',1),hop('b',2),hop('c',3)],1);
  const b=new HopGroup([hop('c',3),hop('a',1),hop('b',2)],1);
  const c=new HopGroup([hop('b',2),hop('c',3),hop('a',1)],1);
  for(let i=0;i<5000;i++){
    const k=key(i),id=a.pick(k)!.id;
    expect(b.pick(k)!.id).toBe(id);
    expect(c.pick(k)!.id).toBe(id);
  }
});

it('migrates only the traffic of a hop that goes unhealthy',()=>{
  const hops=[hop('a'),hop('b'),hop('c'),hop('d')];
  const g=new HopGroup(hops,1);
  const n=20000,before=picks(g,n);
  hops[1]!.healthy=false;
  let moved=0;
  for(let i=0;i<n;i++){
    const now=g.pick(key(i))!.id;
    if(before[i]==='b'){moved++;expect(now).not.toBe('b')}
    else expect(now).toBe(before[i]);
  }
  expect(moved).toBeGreaterThan(0);
});

it('migrates only the traffic of a deleted hop after revision update',()=>{
  const g=new HopGroup([hop('a'),hop('b'),hop('c'),hop('d')],1);
  const n=20000,before=picks(g,n);
  g.update([hop('a'),hop('c'),hop('d')],2);
  expect(g.revision).toBe(2);
  for(let i=0;i<n;i++){
    const now=g.pick(key(i))!.id;
    if(before[i]==='b')expect(now).not.toBe('b');
    else expect(now).toBe(before[i]);
  }
});

it('an added hop steals only the traffic it wins',()=>{
  const g=new HopGroup([hop('a'),hop('b'),hop('c')],1);
  const n=20000,before=picks(g,n);
  g.update([hop('a'),hop('b'),hop('c'),hop('d')],2);
  let moved=0;
  for(let i=0;i<n;i++){
    const now=g.pick(key(i))!.id;
    if(now!==before[i]){moved++;expect(now).toBe('d')}
  }
  expect(moved/n).toBeGreaterThan(0.15);
  expect(moved/n).toBeLessThan(0.35);
});

it('returns no path when every hop is unhealthy',()=>{
  const g=new HopGroup([hop('a',1,false),hop('b',1,false)]);
  expect(g.pick(key(1))).toBeUndefined();
  expect(new HopGroup().pick(key(1))).toBeUndefined();
  const t=new EcmpTable();
  t.add(Uint8Array.from([10]),8,g);
  expect(t.lookup(Uint8Array.from([10,0,0,1]),key(1))).toBeUndefined();
});

it('treats colliding flow keys as the same flow',()=>{
  // distinct variable-length keys with the same 32-bit flow hash (fixed-length
  // inputs can never collide under FNV-1a, so these differ in length too)
  const k1=new TextEncoder().encode('flow-64899');
  const k2=new TextEncoder().encode('flow-115892');
  expect([...k1]).not.toEqual([...k2]);
  expect(hashFlowKey(k1)).toBe(hashFlowKey(k2));
  const hops=[hop('a'),hop('b'),hop('c'),hop('d')];
  const g=new HopGroup(hops,1);
  const first=g.pick(k1)!.id;
  expect(g.pick(k2)!.id).toBe(first);
  hops.find(h=>h.id===first)!.healthy=false;
  const moved=g.pick(k1)!.id;
  expect(moved).not.toBe(first);
  expect(g.pick(k2)!.id).toBe(moved);
});

it('applies config revision updates without moving untouched flows',()=>{
  const g=new HopGroup([hop('a'),hop('b')],1);
  expect(g.revision).toBe(1);
  const before=picks(g,5000);
  g.update([hop('b'),hop('a')],2);
  expect(g.revision).toBe(2);
  expect(picks(g,5000)).toEqual(before);
  g.update([hop('b'),hop('c')],3);
  const after=picks(g,5000);
  expect(g.revision).toBe(3);
  expect(after).not.toContain('a');
  expect(after).toContain('b');
  expect(after).toContain('c');
});

it('freezes one health snapshot per lookup and refreshes it next lookup',()=>{
  let reads=0;
  const flaky={id:'a',weight:1,get healthy(){reads++;return reads===1}};
  const g=new HopGroup([flaky,hop('b',1,false)]);
  expect(g.pick(key(1))?.id).toBe('a');
  expect(reads).toBe(1);
  expect(g.pick(key(1))).toBeUndefined();
  expect(reads).toBe(2);
});

it('reproduces the same choice for the same key across instances',()=>{
  const mk=()=>new HopGroup([hop('a',3),hop('b',2),hop('c',1)],1);
  const g1=mk(),g2=mk();
  for(let i=0;i<2000;i++){
    const k=key(i),id=g1.pick(k)!.id;
    expect(g1.pick(k)!.id).toBe(id);
    expect(g2.pick(k)!.id).toBe(id);
  }
});

it('routes by longest prefix, then picks a stable hop',()=>{
  const t=new EcmpTable();
  const wide=new HopGroup([hop('w1'),hop('w2')]);
  const narrow=new HopGroup([hop('n1'),hop('n2')]);
  t.add(Uint8Array.from([10]),8,wide);
  t.add(Uint8Array.from([10,1]),16,narrow);
  const a=t.lookup(Uint8Array.from([10,1,5,9]),key(7))!;
  expect(['n1','n2']).toContain(a.id);
  expect(t.lookup(Uint8Array.from([10,1,5,9]),key(7))!.id).toBe(a.id);
  expect(['w1','w2']).toContain(t.lookup(Uint8Array.from([10,2,5,9]),key(7))!.id);
  wide.hops.forEach(h=>h.healthy=false);
  expect(t.lookup(Uint8Array.from([10,2,5,9]),key(7))).toBeUndefined();
});
