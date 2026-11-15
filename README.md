# shadows.ink

Physical shadows for web text, images, and shapes. The demo lets you press and drag to draw a sunlight vector, then release to hold it. On a phone, location and orientation follow the real sun.

[Live demo](https://sun-shadow-russ.mrjfgh.chatgpt.site/) · [Source](https://github.com/mrjf/shadows.ink)

## Install

```sh
npm install shadows.ink
```

Try the bundled demo without setting up a project:

```sh
npx shadows.ink
```

Or create a plain HTML/CSS/JavaScript site:

```sh
npx shadows.ink init my-shadow-site
cd my-shadow-site
npm install
npx shadows.ink serve .
```

The demo puts only the newspaper article in the desktop phone frame, with controls outside. Its paper stays light cream: a transparent layer draws shadows without illuminating the page. A longer drawn vector lowers the sun angle and lengthens the shadows; the angle slider adjusts it directly.

The CLI prints a localhost URL. To use phone sensors, publish the static files to an HTTPS host and open the page directly on your phone.

## Opt in with a class

Only elements with `.shadows-ink` cast shadows. Their original HTML remains visible and selectable. Other content stays untouched.

```html
<section id="surface">
  <h1 class="shadows-ink">A little sunlight</h1>
  <p class="shadows-ink">Every word can cast a shadow.</p>
  <img class="shadows-ink" src="./photo.jpg" alt="A leaf">
  <div class="shadows-ink" data-shadow-shape="box">A raised card</div>
  <p>This paragraph stays flat.</p>
</section>
```

```js
import { createShadows } from 'shadows.ink';
import conf from './shadows.config.js';

const shadows = createShadows(document.querySelector('#surface'), conf);
await shadows.ready;
```

For a plain site without a bundler, import from `./node_modules/shadows.ink/src/index.js`. The generated starter uses this form.

## Configuration

Create `shadows.config.js`:

```js
export default {
  selector: '.shadows-ink',
  mode: 'auto',
  gapMm: 0,
  thicknessMm: 1,
  pixelsPerMm: 96 / 25.4,
  material: 'smooth',
  sourceHeightMm: 80,
};
```

| Option | Meaning |
| --- | --- |
| `selector` | Explicit opt-in selector; defaults to `.shadows-ink`. |
| `mode` | `auto` uses a cursor on desktop and waits for setup on mobile. Also accepts `cursor`, `sunlight`, or `manual`. |
| `gapMm` | Clearance between the shape and its receiving surface. |
| `thicknessMm` | Thickness of the opaque shape. Both gap and thickness at zero produce no shadow. |
| `pixelsPerMm` | Physical screen scale. The CSS estimate is approximate; calibrate against a ruler for physical dimensions. Pinch zoom is handled internally. |
| `material` | `smooth`, `concrete`, `glass`, `wood`, or `graph`. Texture is deliberately visible only inside the cast shadow. |
| `sourceHeightMm` | Height of the desktop cursor light above the surface. |
| `onStatus` | Receives permission, calibration, tracking, and error messages for your UI. |
| `paintMask` | Optional Canvas2D drawing callback for custom silhouettes. |

Change configuration live:

```js
shadows.setOptions({ gapMm: 0.5, thicknessMm: 1, material: 'glass' });
```

The plugin creates a transparent, non-interactive canvas behind the selected elements. It preserves the site's background and foreground. Advanced integrations can supply `canvas` and opt into the demo's shaded paper with `transparent: false`; these two options are fixed at creation.

## Phone setup

Browsers require a user gesture for motion permission. Connect a real button to `startSunlight()`, then use the status callback to guide calibration:

```js
const action = document.querySelector('#sunlight-action');
const message = document.querySelector('#sunlight-status');
const shadows = createShadows(document.querySelector('#surface'), {
  ...conf,
  onStatus(status) {
    message.textContent = status.message;
    action.hidden = !status.action;
    action.textContent = status.actionLabel ?? '';
    action.disabled = status.action === 'calibrate' && !status.canCalibrate;
  },
});
action.addEventListener('click', () => {
  if (shadows.status.action === 'calibrate') shadows.calibrate();
  else shadows.startSunlight();
});
```

Location and motion stay in the page; they are never sent to a server or saved. Live shadows wait for location, orientation, and explicit compass or sun alignment. Missing permissions produce actionable status messages. `beginCalibration('sun')` shows manual alignment guidance; `calibrate()` commits the alignment. `stopSunlight()` stops the sensors and returns to setup.

## Shapes and lifecycle

Text uses the element's rendered line breaks and styles. Images use their alpha silhouette and object-fit. Rounded rectangles use `data-shadow-shape="box"`. For other shapes, provide a custom mask in CSS coordinates relative to the root:

```js
const shadows = createShadows(surface, {
  ...conf,
  paintMask(context, width, height) {
    context.fillStyle = 'white';
    context.beginPath();
    context.arc(width / 2, height / 2, 40, 0, Math.PI * 2);
    context.fill();
  },
});
```

The mask defines the caster; your page draws its foreground. The low-level `SunRenderer`, `drawElementMask`, `sunPosition`, and `screenLight` are also exported.

```js
await shadows.refresh();       // Rebuild a changed custom silhouette.
shadows.setLight({ direction: [1, 0, 1], daylight: true }); // Manual light.
shadows.setLight({ positionMm: [40, 30, 80], daylight: true });
shadows.setOptions({ mode: 'auto' });
shadows.destroy();             // Disconnect sensors/observers and remove owned canvas.
```

Root/element resizing, font loading, image loading, and class/content changes update the mask automatically. Destroy an instance when removing its root.

## Limits

Requires WebGL 2 and a modern browser. The DOM adapter handles untransformed text, images, and rounded boxes; it is not a screenshot engine for every CSS effect, SVG, pseudo-element, or transformed subtree. Use `paintMask` for custom geometry. Images must be same-origin or CORS-readable. A root whose children paint opaque backgrounds can hide shadows beneath those backgrounds; select the container as a box when that is the intended object.

Geometry uses millimeters, but display density and compass readings are estimates. The renderer uses finite ray-marching and light samples; it is physically based, not a complete simulation of weather, rooms, or every material. The texture choices are a shadow-only appearance effect, including rippled glass, rather than a refraction simulation. Native iOS/Android SDKs are not included in this web package.

## Develop and test

```sh
npm ci
npm run build
npm test
npx playwright-core install chromium webkit
npm run test:install
npm run dev
```

`test:install` packs the package, installs that tarball into a separate plain website, and loads the installed files in Chromium and WebKit. It checks the class opt-in, transparency, live configuration, and installed CLI. It does not import the library from this checkout.

`src/` is the plugin source. `website/` is the demo. `npm run build` copies the three library modules into the website for standalone static hosting. `bin/` contains the dependency-free CLI.

Software is MIT licensed. See [NOTICE.md](NOTICE.md) for the archival demo photograph and article attribution.
