# Updated Lighthouse drawing

`lighthouse-2026.svg` is Lighthouse as of September 2026 in tarkov.dev's flat drawing style. The app
shows it as "Updated drawing (2026)", the default Lighthouse picture. It travels in the Lighthouse
content pack (`scripts/tile-lighthouse.mjs` copies it next to the RE3MR tiles), so it is not in the
installer.

**Sources and licences**
- **Layout** (sea, land, forest, rock, sand, dirt, concrete, roads, buildings): Jindouz's 2D Lighthouse
  map, uploaded by him to the EFT Wiki (`File:Jindouz Lighthouse Map V1.png`, September 2026; the
  wiki's licence is CC BY-SA 3.0).
- **Style and the playable-area border**: tarkov.dev's drawing
  ([the-hideout/tarkov-dev-svg-maps](https://github.com/the-hideout/tarkov-dev-svg-maps), Shebuka and
  contributors, CC BY-NC-SA 4.0, not for use in cheating software).
- **Minefields**: the game's own outlines from json.tarkov.dev (`minefields.json`, from `hazards.cjs`).

## Why Jindouz's map, and how it is placed

The first version (2.18.0) was traced from RE3MR's render. Checked against the game's own data, that
render drifts:
- 7–12 m at the water plant;
- about 70 m on Lightkeeper island, where its lighthouse stands where the game has open rock.

As a result, containers and loot showed up beside their buildings.

The game data says where the buildings really are. Indoor-only spots must lie inside a building:
- 844 loose-loot spots;
- the drawers, jackets, PC blocks, safes and medcases among the containers;
- the door locks.

`jindouz.cjs fit` slides Jindouz's map over the game positions in 260 m windows. For each window it
finds the shift, turn and scale that put the most of those spots on his building pixels. Most windows
are about 10–25 m off and turned 2°; the island is about 30 m off. `jindouz.cjs extract` then:
- sorts every pixel of his map into a class by colour;
- fills labels, icons and outlines in from their surroundings;
- blanks his floor-plan panels;
- traces each class with marching squares and simplifies the outlines;
- squares up building walls;
- places everything through the blended window fits.

The result is `specs/jindouz.json`.

`check.cjs` is the measure. Of the 110 indoor-only spots (car trunks left out), 93 lie inside a drawn
building. The 2.18.0 drawing managed 32. The misses are:
- spots 1–3 m from a wall: doors sit on walls, and upper floors on the island;
- a crashed helicopter;
- a few jackets on open ground.

Drawn by hand over the fitted map, in game positions:
- `specs/island.json`: the causeway (a straight line that passes over the game's parked car and its
  claymores), its road and the island's north jetty;
- `specs/extras.json`:
  - the water plant's eight basins (open, covered, empty) and the terminal's five tracks;
  - the seaside houses on their piers by the Icebreaker transit (his map's label sits on them);
  - the three roadblocks on the main road (middle, UN checkpoint, south): vehicles, concrete blocks
    and the road gantry. They are traced from RE3MR's render, which is within about 3 m there (the
    game's loot lies in and beside its vehicles). The layout's own shapes inside those areas are
    left out (`replace`).
  - the four camps where Jindouz puts his tent icon, drawn as a tent in a clearing
    (`jindouz.cjs camps` lists the icons it finds; some hits are label lettering, so only the
    checked ones are listed);
  - the crashed helicopter at the hill camp.

Vehicles in his map (narrow outlines under 40 m²) are drawn as vehicles, not buildings.

## Commands (run from the repository root; without Node use `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe`)

- `node scripts/lighthouse-map/jindouz.cjs fetch`: downloads Jindouz's map to `assets-src/lighthouse/` (SHA-256 checked).
- `node scripts/lighthouse-map/check.cjs scripts/lighthouse-map/lighthouse-2026.svg --cache=<points.json> [--list]`: fetches the game points once into the cache and prints the indoor check.
- `node scripts/lighthouse-map/jindouz.cjs fit --cache=<points.json>`: the window fits, written to `specs/jindouz-fits.json`.
- `node scripts/lighthouse-map/jindouz.cjs extract`: writes `specs/jindouz.json`; single-threaded, a few seconds.
- `node scripts/lighthouse-map/build.cjs scripts/lighthouse-map/tarkov-dev-lighthouse.svg scripts/lighthouse-map/minefields.json scripts/lighthouse-map/lighthouse-2026.svg`: builds the drawing from the committed specs. It does not need the picture.
- `jindouz.cjs view <out.png> --box=u0,v0,u1,v1 [--px=3] [--cache=<points.json>]`: the fitted map with game points, for checking and measuring. `jindouz.cjs probe --box=…` prints the map's colours there.
- `drawing.cjs <svg> <out.png> --box=… [--points=…]`: a drawing with game points on top. `trace.cjs` and `side.cjs` show RE3MR's render the same way (they need `assets-src/lighthouse/re3mrLighthouseVERT.png` or the built tiles).

If Jindouz updates his map, fetch it with the new checksum and run `fit`, `extract`, `build` and `check` again. Then look at the result with `drawing.cjs` before shipping it.
