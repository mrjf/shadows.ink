import { SunRenderer, drawElementMask } from './render.js';
import { sunPosition, screenLight, compassOffset } from './physics.js';

export { SunRenderer, drawElementMask, signedDistanceField } from './render.js';
export { sunPosition, screenLight, compassOffset } from './physics.js';

const defaults = { selector: '.shadows-ink', gapMm: 0, thicknessMm: 3, pixelsPerMm: 96/25.4,
  material: 'smooth', mode: 'auto', sourceHeightMm: 80, transparent: true };
const materials = ['smooth','concrete','glass','wood','graph'];
const screenAngle = () => screen.orientation?.angle ?? (typeof window.orientation === 'number' ? window.orientation : 0);
const vector = (value,name) => {
  if (!value || value.length !== 3 || !Array.from(value).every(Number.isFinite)) throw new TypeError(`${name} must contain three finite numbers.`);
  return Array.from(value);
};
function validate(options) {
  for (const name of ['gapMm','thicknessMm']) if (!Number.isFinite(options[name]) || options[name] < 0) throw new RangeError(`${name} must be nonnegative millimeters.`);
  for (const name of ['pixelsPerMm','sourceHeightMm']) if (!Number.isFinite(options[name]) || options[name] <= 0) throw new RangeError(`${name} must be positive.`);
  if (!materials.includes(options.material)) throw new RangeError(`Unknown shadow texture: ${options.material}.`);
  if (!['auto','cursor','sunlight','manual'].includes(options.mode)) throw new RangeError(`Unknown shadow mode: ${options.mode}.`);
  if (typeof options.selector !== 'string') throw new TypeError('selector must be a CSS selector.');
  if (options.paintMask !== undefined && typeof options.paintMask !== 'function') throw new TypeError('paintMask must be a drawing function.');
  if (options.onStatus !== undefined && typeof options.onStatus !== 'function') throw new TypeError('onStatus must be a function.');
}

export function isMobileDevice() {
  if (typeof navigator === 'undefined') return false;
  return navigator.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Add a transparent physical shadow layer behind explicitly opted-in elements. */
export function createShadows(root,initial = {}) {
  if (!(root instanceof HTMLElement)) throw new TypeError('createShadows needs a root HTMLElement.');
  let options = { ...defaults,...initial }; validate(options); root.querySelectorAll(options.selector);
  const mobile = isMobileDevice();
  const initialMode = () => options.mode === 'auto' ? (mobile ? 'setup' : 'cursor') : options.mode === 'sunlight' ? 'setup' : options.mode;
  let mode = initialMode(),destroyed = false,renderer = null,frame = 0,revision = 0,cursor = null;
  let watcher = null,timer = null,generation = 0,coordinates = null,reading = null,northOffset = null;
  let locatingSince = 0,locationIssue = '',calibrating = false,calibrationKind = 'compass',aligned = false;
  let manual = { direction: [0,0,1],positionMm: null,daylight: true,skyUp: [0,0,1],angularRadius: .00465,altitude: 90 };
  let status = null,lastStatus = '';
  const events = new AbortController(),ownedCanvas = !options.canvas;
  const canvas = options.canvas ?? document.createElement('canvas');
  if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('canvas must be an HTMLCanvasElement.');
  const original = { position: root.style.position,isolation: root.style.isolation };
  const changedPosition = ownedCanvas && getComputedStyle(root).position === 'static';
  if (ownedCanvas) {
    if (changedPosition) root.style.position = 'relative';
    root.style.isolation = 'isolate';
    canvas.setAttribute('aria-hidden','true');canvas.dataset.shadowsInk = '';
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;z-index:-1;';
    root.prepend(canvas);
  }
  const listen = (target,name,handler,extra = {}) => target.addEventListener(name,handler,{ ...extra,signal: events.signal });
  const ensureActive = () => { if (destroyed) throw new Error('This shadow instance has been destroyed.'); };
  function emit(phase,label,message = '',extra = {}) {
    status = Object.freeze({ mode,phase,label,message,action: null,actionLabel: null,canCalibrate: false,calibrationMethod: null,canAlign: false,...extra });
    const signature = JSON.stringify(status);
    if (signature !== lastStatus) { lastStatus = signature;options.onStatus?.(status); }
  }
  function requestPaint() {
    if (!destroyed && !frame) frame = requestAnimationFrame(() => { frame = 0;try { paint(); } catch (error) { fail(error); } });
  }
  function draw(light,ready = true) {
    renderer?.draw({ light: light.direction,lightPositionMm: light.positionMm ?? null,skyUp: light.skyUp ?? [0,0,1],
      daylight: Boolean(ready && light.daylight),angularRadius: light.angularRadius ?? .00465,altitude: light.altitude ?? 90,
      gapMm: ready ? options.gapMm : 0,thicknessMm: ready ? options.thicknessMm : 0,
      pixelsPerMm: options.pixelsPerMm/(window.visualViewport?.scale ?? 1),material: options.material });
  }
  function hideShadow() { draw({ direction: [0,0,1],daylight: false },false); }
  function disconnect() {
    generation++;
    if (watcher !== null) navigator.geolocation.clearWatch(watcher);
    watcher = null;clearInterval(timer);timer = null;
    window.removeEventListener('deviceorientation',orientationChanged);
    window.removeEventListener('deviceorientationabsolute',orientationChanged);
    coordinates = null;reading = null;northOffset = null;aligned = false;locationIssue = '';calibrationKind = 'compass';calibrating = false;
  }
  function setup(message = 'Allow location and motion, then set your compass.',action = 'start') {
    disconnect();mode = 'setup';emit('setup','Setup',message,{ action,actionLabel: action === 'retry' ? 'Retry' : 'Set up sunlight' });requestPaint();
  }
  function fail(error) {
    if (destroyed) return;
    disconnect();mode = 'setup';emit('error','Unavailable',error.message || String(error));
    if (renderer) { renderer.destroy();renderer = null; }
  }
  const flat = () => reading && Math.abs(reading.beta) <= 15 && Math.abs(reading.gamma) <= 15;
  const method = () => calibrationKind === 'sun' || (!reading.absolute && !Number.isFinite(reading.webkitCompassHeading)) ? 'sun' : 'compass';
  function orientationChanged(event) {
    if (mode !== 'sunlight' || ![event.alpha,event.beta,event.gamma].every(Number.isFinite)) return;
    if (northOffset !== null && reading && Boolean(event.absolute) !== Boolean(reading.absolute)) return;
    if (reading?.absolute && !event.absolute) return;
    reading = { alpha: event.alpha,beta: event.beta,gamma: event.gamma,absolute: Boolean(event.absolute),
      webkitCompassHeading: event.webkitCompassHeading,webkitCompassAccuracy: event.webkitCompassAccuracy };
    requestPaint();
  }
  function paint() {
    if (destroyed || document.hidden) return;
    if (mode === 'setup') { hideShadow();return; }
    if (mode === 'cursor') {
      const bounds = canvas.getBoundingClientRect(),scale = options.pixelsPerMm/(window.visualViewport?.scale ?? 1);
      const x = cursor ? cursor.x-bounds.left : bounds.width*.25,y = cursor ? bounds.bottom-cursor.y : bounds.height*.9;
      draw({ direction: [0,0,1],positionMm: [x/scale,y/scale,options.sourceHeightMm],daylight: true });
      emit('cursor','Cursor light','Move your cursor to cast shadows.');return;
    }
    if (mode === 'manual') { draw(manual);emit('manual','Custom light');return; }
    if (!coordinates) {
      hideShadow();emit('location','Location setup',locationIssue || (performance.now()-locatingSince > 5000
        ? 'Still locating. Turn on Location Services and allow this site to use your location.' : 'Allow location access when asked.'),
      locationIssue ? { action: 'retry',actionLabel: 'Retry' } : {});return;
    }
    const sun = sunPosition(new Date(),coordinates.latitude,coordinates.longitude);
    if (!reading) {
      hideShadow();emit('motion','Motion setup',performance.now()-locatingSince > 6000
        ? 'No motion data. Open this link directly in Safari or Chrome, then tap Retry.' : 'Tilt your phone gently to connect its motion sensors.',
      performance.now()-locatingSince > 6000 ? { action: 'retry',actionLabel: 'Retry' } : {});return;
    }
    if (calibrating || northOffset === null) {
      hideShadow();const calibrationMethod = method();
      if (calibrationMethod === 'sun' && sun.altitude <= 0) {
        emit('calibration','Compass setup','No compass reading, and the sun has set. Open this page in Safari or Chrome and tap Retry.',{ action: 'retry',actionLabel: 'Retry',calibrationMethod });return;
      }
      const headingReady = calibrationMethod === 'sun' || reading.absolute || compassOffset(reading) !== null;
      emit('calibration','Compass setup',!flat() ? 'Lay your phone flat, screen facing up.' : !headingReady
        ? 'Move your phone in a figure eight, then lay it flat to calibrate its compass.' : calibrationMethod === 'sun'
          ? 'Keep the phone flat. Point the top of the screen toward the sun, then tap Align to sun.' : 'Keep the phone flat, then tap Set compass.',
      { action: 'calibrate',actionLabel: calibrationMethod === 'sun' ? 'Align to sun' : 'Set compass',canCalibrate: Boolean(flat() && headingReady),calibrationMethod });return;
    }
    const orientation = { alpha: reading.alpha+northOffset,beta: reading.beta,gamma: reading.gamma };
    const direction = screenLight(sun.vector,orientation,screenAngle());
    draw({ direction,daylight: sun.altitude > 0,skyUp: screenLight([0,0,1],orientation,screenAngle()),angularRadius: sun.angularRadius,altitude: sun.altitude });
    const label = aligned ? 'Live · sun aligned' : 'Live · compass';
    if (sun.altitude <= 0) emit('night',label,'The sun has set here. Come back in daylight for a sun shadow.',{ canAlign: true });
    else if (direction[2] <= 0) emit('backlit',label,'The sun is behind the phone. Turn the screen toward the sun.',{ canAlign: true });
    else if (direction[2] < Math.sin(5*Math.PI/180) && options.gapMm+options.thicknessMm > 0)
      emit('grazing',label,'Sunlight is nearly parallel to the screen. Face the screen toward the sun to shorten the shadow.',{ canAlign: true });
    else emit('live',label,'',{ canAlign: true });
  }
  function permissionHelp(kind) {
    if (kind === 'motion') return 'Motion is blocked. Reload this page in Safari or Chrome, tap Set up sunlight, and choose Allow for motion and orientation.';
    return /iPhone|iPad/.test(navigator.userAgent)
      ? 'Location is blocked. In Safari’s page menu, open Website Settings → Location → Allow. Then tap Retry.'
      : 'Location is blocked. In this site’s browser permissions, allow Location. Then tap Retry.';
  }
  async function startSunlight() {
    ensureActive();disconnect();mode = 'sunlight';calibrating = true;hideShadow();
    if (!isSecureContext) { setup('Motion and location need HTTPS. Open this page using its secure website address.','retry');return; }
    if (!navigator.geolocation || !window.DeviceOrientationEvent) { setup('Open this link in Safari or Chrome on your phone, then tap Set up sunlight.');return; }
    const current = generation;locatingSince = performance.now();
    emit('motion','Connecting…','Choose Allow for motion and location.');
    window.addEventListener('deviceorientation',orientationChanged);
    window.addEventListener('deviceorientationabsolute',orientationChanged);
    try {
      const permission = typeof DeviceOrientationEvent.requestPermission === 'function' ? await DeviceOrientationEvent.requestPermission(true) : 'granted';
      if (current !== generation || destroyed) return;
      if (permission !== 'granted') throw new Error(permissionHelp('motion'));
      locatingSince = performance.now();
      watcher = navigator.geolocation.watchPosition(position => {
        if (current !== generation || destroyed) return;
        const { latitude,longitude,accuracy } = position.coords;
        const valid = Number.isFinite(latitude) && Math.abs(latitude) <= 90 && Number.isFinite(longitude) && Math.abs(longitude) <= 180
          && Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 1000;
        coordinates = valid ? { latitude,longitude } : null;
        locationIssue = valid ? '' : 'Location is too approximate. Enable Precise Location for your browser, then tap Retry.';requestPaint();
      },error => {
        if (current !== generation || destroyed) return;
        setup(error.code === 1 ? permissionHelp('location') : error.code === 3
          ? 'Location timed out. Turn on Location Services for your browser, then tap Retry.'
          : 'Your phone can’t find its location. Turn on Location Services, then tap Retry.','retry');
      },{ enableHighAccuracy: true,maximumAge: 0,timeout: 15000 });
      timer = setInterval(requestPaint,1000);requestPaint();
    } catch (error) { if (current === generation && !destroyed) setup(error.message || permissionHelp('motion'),'retry'); }
  }
  const targets = () => Array.from(root.querySelectorAll(options.selector));
  const resize = new ResizeObserver(() => { void refresh().catch(fail); });
  function observeTargets() {
    resize.disconnect();resize.observe(root);for (const element of targets()) resize.observe(element);
  }
  async function waitForImages() {
    const images = new Set(targets().flatMap(element => element instanceof HTMLImageElement ? [element] : Array.from(element.querySelectorAll('img'))));
    await Promise.all(Array.from(images,image => image.decode()));
  }
  async function refresh() {
    ensureActive();const current = ++revision;
    await waitForImages();
    if (destroyed || current !== revision) return;
    renderer?.invalidateMask();requestPaint();
  }
  const mutations = new MutationObserver(records => {
    if (records.every(record => record.target === canvas)) return;
    observeTargets();void refresh().catch(fail);
  });
  mutations.observe(root,{ subtree: true,childList: true,characterData: true,attributes: true,
    attributeFilter: ['style','class','src','srcset','sizes','hidden','data-shadow-shape','width','height'] });
  listen(window,'pointermove',event => {
    if (mode !== 'cursor' || event.pointerType === 'touch' || document.querySelector('dialog[open]')) return;
    cursor = { x: event.clientX,y: event.clientY };requestPaint();
  });
  listen(window,'resize',() => { void refresh().catch(fail); });
  listen(window,'scroll',requestPaint,{ capture: true,passive: true });
  listen(window,'orientationchange',requestPaint);
  if (window.visualViewport) listen(window.visualViewport,'resize',() => { void refresh().catch(fail); });
  if (document.fonts) listen(document.fonts,'loadingdone',() => { void refresh().catch(fail); });
  listen(root,'load',event => { if (event.target instanceof HTMLImageElement) void refresh().catch(fail); },{ capture: true });
  listen(document,'visibilitychange',() => { if (document.hidden) hideShadow();else requestPaint(); });
  listen(window,'pagehide',disconnect);
  listen(window,'pageshow',event => { if (event.persisted && mode === 'sunlight') setup();else requestPaint(); });
  listen(canvas,'webglcontextlost',event => { event.preventDefault();fail(new Error('The graphics connection was interrupted. Reload this page to reconnect.')); });
  const api = {
    get status() { return status; },get options() { return Object.freeze({ ...options }); },get canvas() { return canvas; },
    ready: null,
    setOptions(next) {
      ensureActive();
      if ('canvas' in next || 'transparent' in next) throw new Error('canvas and transparent are fixed when the shadow instance is created.');
      const updated = { ...options,...next };validate(updated);root.querySelectorAll(updated.selector);options = updated;
      if ('mode' in next) { disconnect();mode = initialMode();if (mode === 'setup') setup(); }
      observeTargets();void refresh().catch(fail);return api;
    },
    setLight(light) {
      ensureActive();const direction = vector(light.direction ?? [0,0,1],'direction'),length = Math.hypot(...direction);
      if (!length) throw new RangeError('direction must not be zero.');
      const positionMm = light.positionMm === undefined || light.positionMm === null ? null : vector(light.positionMm,'positionMm');
      if (positionMm && positionMm[2] <= 0) throw new RangeError('positionMm must be above the surface.');
      const skyUp = vector(light.skyUp ?? [0,0,1],'skyUp'),skyLength = Math.hypot(...skyUp);
      if (!skyLength) throw new RangeError('skyUp must not be zero.');
      const angularRadius = light.angularRadius ?? .00465,altitude = light.altitude ?? 90;
      if (!Number.isFinite(angularRadius) || angularRadius < 0 || angularRadius >= Math.PI/2 || !Number.isFinite(altitude)) throw new RangeError('Supply a finite altitude and angularRadius between 0 and PI/2 radians.');
      disconnect();mode = 'manual';manual = { direction: direction.map(value => value/length),positionMm,skyUp: skyUp.map(value => value/skyLength),angularRadius,altitude,daylight: light.daylight ?? true };
      requestPaint();return api;
    },
    refresh,startSunlight,
    beginCalibration(kind = 'compass') {
      ensureActive();if (!['compass','sun'].includes(kind)) throw new TypeError('Calibration must use compass or sun.');
      if (mode !== 'sunlight') return false;
      calibrationKind = kind;calibrating = true;requestPaint();return true;
    },
    calibrate(kind) {
      ensureActive();if (kind !== undefined && !['compass','sun'].includes(kind)) throw new TypeError('Calibration must use compass or sun.');
      if (mode !== 'sunlight' || !coordinates || !reading || !flat()) return false;
      if (kind) calibrationKind = kind;
      if (method() === 'sun') {
        const sun = sunPosition(new Date(),coordinates.latitude,coordinates.longitude);if (sun.altitude <= 0) return false;
        northOffset = -sun.azimuth+screenAngle()-reading.alpha;aligned = true;
      } else { const offset = reading.absolute ? 0 : compassOffset(reading);if (offset === null) return false;northOffset = offset;aligned = false; }
      calibrating = false;requestPaint();return true;
    },
    stopSunlight() { ensureActive();if (mobile || options.mode === 'sunlight') setup();else { disconnect();mode = 'cursor';requestPaint(); }return api; },
    destroy() {
      if (destroyed) return;
      destroyed = true;revision++;disconnect();cancelAnimationFrame(frame);events.abort();resize.disconnect();mutations.disconnect();
      renderer?.destroy();renderer = null;
      if (ownedCanvas) {
        canvas.remove();
        if (changedPosition && root.style.position === 'relative') root.style.position = original.position;
        if (root.style.isolation === 'isolate') root.style.isolation = original.isolation;
      }
      mode = 'destroyed';emit('destroyed','Stopped');
    },
  };
  api.ready = (async () => {
    await Promise.all([document.fonts?.ready,waitForImages()]);
    if (destroyed) return api;
    renderer = new SunRenderer(canvas,{ transparent: options.transparent,compositeForeground: false,
      paintMask: (context,width,height) => {
        if (options.paintMask) { options.paintMask(context,width,height);return; }
        const bounds = root.getBoundingClientRect(),surface = canvas.getBoundingClientRect();
        context.translate(bounds.left-surface.left,bounds.top-surface.top);drawElementMask(context,root,options.selector);
      } });
    observeTargets();if (mode === 'setup') setup();paint();return api;
  })().catch(error => { fail(error);throw error; });
  return api;
}
