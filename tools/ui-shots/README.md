# UI screenshots

Headless Chromium over the DevTools protocol, no dependencies. Used for design reviews: the same
screens at phone, tablet, desktop and TV sizes, in English and Swedish.

```sh
# The real library (LAN): every request that isn't GET is refused, so nothing changes on the server
node tools/ui-shots/shoot.mjs --base http://SERVER:8080 --out shots/before

# A branch's public/ against the real API, without deploying it
node tools/ui-shots/shoot.mjs --base http://SERVER:8080 --overlay public --out shots/after

# The preview (PREVIEW_DIR) on the server
node tools/ui-shots/shoot.mjs --base http://SERVER:8080 --preview --out shots/preview

# Owner screens and edge cases on a throwaway local server (identity headers are trusted from loopback)
node tools/ui-shots/shoot.mjs --base http://localhost:8091 --as owner@example.test --allow-writes --scenes 'owner-*,signin*,share-*'

# Contact sheet, before | after
node tools/ui-shots/contact.mjs shots/before sheet.png --pair shots/after --cols 3 --width 260
```

Options: `--scenes a,b,prefix*`, `--sizes phone,tablet,desktop,tv`, `--langs en,sv`,
`--theme paper` (any Appearance preset), `--reduced-motion`. Scenes, their steps and API mocks are in
`scenes.mjs`. Each run writes PNGs, half-size JPEGs in `small/` and `report.json` with console errors.
