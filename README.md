# IP routing core

TypeScript library for prefix routing tables.

Run `npm install`, then `npm test` and `npm run build`.

## ECMP next hop groups

`NextHopGroup` selects one next hop per flow key over a weighted consistent-hash
ring:

- Each next hop owns integer slots proportional to its weight
  (`slotsPerWeight` per weight unit, capped by `maxSlots`); every node keeps at
  least one slot, so there are no empty slots.
- Selection is stable: reordering next hops changes nothing, and adding or
  removing a node only migrates the flows owned by that node.
- Each `select(flowKey)` freezes one health snapshot; unhealthy nodes are
  skipped, and if all are unhealthy it returns `undefined`.
- `set()` bumps `revision`; `setHealthy()` does not.

```ts
import { EcmpRouteTable } from 'route-ecmp-core';

const table = new EcmpRouteTable();
const group = table.add({
  network: Uint8Array.from([10]), prefix: 8,
  nextHops: [{ id: 'a', weight: 5 }, { id: 'b', weight: 3 }, { id: 'c', weight: 2 }],
});
group.setHealthy('b', false);
table.lookup(Uint8Array.from([10, 2, 3, 4]), 'src=1.2.3.4,dst=5.6.7.8'); // => NextHop | undefined
```
