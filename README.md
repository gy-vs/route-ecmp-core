# IP routing core

TypeScript library for prefix routing tables.

Run `npm install`, then `npm test` and `npm run build`.

## Weighted ECMP

A prefix can carry multiple next hops. `HopGroup` selects one hop per flow key
with weighted rendezVous hashing (multi-straw):

- weights are mapped to an integer slot space; every positive weight keeps at
  least one slot (no empty slots), zero weight is never selected
- a hop's score depends only on `(flowKey, hopId, slot)`, so reordering the hop
  list never changes the result, and adding/removing a hop only migrates the
  flows it wins
- `pick` reads each hop's `healthy` flag exactly once (one frozen snapshot per
  lookup); it returns `undefined` when no hop is available
- membership/weight changes are published with `update(hops, revision)`;
  `healthy` is read live without a revision bump

```ts
const group = new HopGroup([
  {id: 'a', weight: 1, healthy: true},
  {id: 'b', weight: 2, healthy: true},
], 1);

group.pick(flowKey);            // deterministic for a given flow key
group.update(hops, 2);          // new config revision
group.revision;                 // 2

const table = new EcmpTable();  // longest-prefix match + per-prefix ECMP
table.add(Uint8Array.from([10]), 8, group);
table.lookup(address, flowKey); // NextHop | undefined
```
