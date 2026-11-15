import { createShadows, isMobileDevice } from './shadows.js';
import conf from './shadows.config.js';

const $ = id => document.getElementById(id);
const mobile = isMobileDevice();
document.body.dataset.device = mobile ? 'mobile' : 'desktop';
showDesktopControls();
function showDesktopControls() { $('sun-control').hidden = mobile; }
let pixelsPerMm = conf.pixelsPerMm, calibrationDpr = devicePixelRatio;
const viewportZoom = () => window.visualViewport?.scale ?? 1;
const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
const show = (id, visible) => { if ($(id).hidden === visible) $(id).hidden = !visible; };

const shadows = createShadows($('shadow-page'), {
  ...conf,
  mode: mobile ? 'auto' : 'manual',
  canvas: $('scene'),
  transparent: true,
  onStatus(status) {
    text('mode', mobile ? status.label : 'Directional sunlight');
    text('status', mobile ? status.message : 'Try on mobile for the true sun angle.');
    show('start', status.action === 'start' || status.action === 'retry');
    if (status.action === 'start' || status.action === 'retry') text('start', status.actionLabel);
    show('calibrate', status.action === 'calibrate');
    if (status.action === 'calibrate') text('calibrate', status.actionLabel);
    $('calibrate').disabled = !status.canCalibrate;
    show('align', status.canAlign);
    show('stop', status.mode === 'sunlight');
    show('secure-link', mobile && !isSecureContext);
    if (status.phase === 'error') document.body.dataset.renderer = 'failed';
  },
});
shadows.ready.catch(error => {
  document.body.dataset.renderer = 'failed';
  text('status', error.message); show('start', false);
});
$('start').addEventListener('click', () => shadows.startSunlight());
$('calibrate').addEventListener('click', () => shadows.calibrate());
$('stop').addEventListener('click', () => { shadows.stopSunlight(); $('settings').close(); });
$('align').addEventListener('click', () => { $('settings').close(); shadows.beginCalibration('sun'); });
$('settings-open').addEventListener('click', () => $('settings').showModal());
$('settings-close').addEventListener('click', () => $('settings').close());
$('settings').addEventListener('click', event => {
  if (event.target !== $('settings')) return;
  const box = $('settings').getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('settings').close();
});
for (const [id, option] of [['height', 'gapMm'], ['thickness', 'thicknessMm']]) {
  $(id).value = String(conf[option]);
  const update = () => {
    const value = `${$(id).value} mm`;
    text(`${id}-value`, value); $(id).setAttribute('aria-valuetext', value);
    shadows.setOptions({ [option]: Number($(id).value) });
  };
  $(id).addEventListener('input', update); update();
}
$('surface').value = conf.material;
$('surface').addEventListener('change', () => shadows.setOptions({ material: $('surface').value }));
function updateScaleRuler() {
  $('scale-ruler').style.width = `${30 * Number($('screen-scale').value) / viewportZoom()}px`;
}
$('scale-open').addEventListener('click', () => {
  $('screen-scale').value = String(pixelsPerMm);
  updateScaleRuler(); $('settings').close(); $('scale-settings').showModal();
});
$('screen-scale').addEventListener('input', updateScaleRuler);
$('scale-done').addEventListener('click', () => {
  pixelsPerMm = Number($('screen-scale').value); calibrationDpr = devicePixelRatio;
  text('scale-status', 'Ruler-calibrated');
  shadows.setOptions({ pixelsPerMm });
  $('scale-settings').close(); $('settings').showModal();
});
$('scale-close').addEventListener('click', () => { $('scale-settings').close(); $('settings').showModal(); });
$('scale-settings').addEventListener('cancel', event => { event.preventDefault(); $('scale-close').click(); });
window.addEventListener('resize', () => {
  if (devicePixelRatio === calibrationDpr) return;
  pixelsPerMm = conf.pixelsPerMm; calibrationDpr = devicePixelRatio;
  text('scale-status', 'Estimated scale'); shadows.setOptions({ pixelsPerMm });
});
window.visualViewport?.addEventListener('resize', updateScaleRuler);

let azimuth = -Math.PI / 4, elevation = 35, vectorStart = null;
function applySunVector() {
  const h = elevation * Math.PI / 180;
  shadows.setLight({ direction: [-Math.cos(azimuth) * Math.cos(h), Math.sin(azimuth) * Math.cos(h), Math.sin(h)], daylight: true });
  $('sun-angle').value = String(elevation);
  text('sun-angle-value', `${Math.round(elevation)}°`);
  $('sun-angle').setAttribute('aria-valuetext', `${Math.round(elevation)} degrees above the page`);
  // The preview arrow points along the incoming ray, opposite the direction to the sun.
  $('direction-arrow').setAttribute('transform', `rotate(${azimuth * 180 / Math.PI - 45} 40 40)`);
}
if (!mobile) {
  azimuth = Math.PI / 4;
  applySunVector();
  $('sun-angle').addEventListener('input', () => { elevation = Number($('sun-angle').value); applySunVector(); });
  $('vector-reset').addEventListener('click', () => { azimuth = Math.PI / 4; elevation = 35; applySunVector(); });
  window.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.pointerType === 'touch' || event.target.closest('button, input, select, a, dialog') || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    vectorStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
    document.body.setPointerCapture(event.pointerId);
    document.body.dataset.drawing = 'true';
    const ray = $('sun-ray'), origin = $('sun-origin');
    ray.setAttribute('x1', event.clientX); ray.setAttribute('y1', event.clientY);
    ray.setAttribute('x2', event.clientX); ray.setAttribute('y2', event.clientY);
    origin.setAttribute('cx', event.clientX); origin.setAttribute('cy', event.clientY);
    $('sun-vector-angle').setAttribute('x', event.clientX + 16); $('sun-vector-angle').setAttribute('y', event.clientY - 16);
    text('sun-vector-angle', 'Drag to set the angle');
    $('sun-vector').removeAttribute('hidden');
  });
  window.addEventListener('pointermove', event => {
    if (!vectorStart || event.pointerId !== vectorStart.id) return;
    const dx = event.clientX - vectorStart.x, dy = event.clientY - vectorStart.y, length = Math.hypot(dx, dy);
    $('sun-ray').setAttribute('x2', event.clientX); $('sun-ray').setAttribute('y2', event.clientY);
    if (length < 8) return;
    azimuth = Math.atan2(dy, dx);
    elevation = Math.max(8, Math.min(80, Math.atan2(20 * pixelsPerMm / viewportZoom(), length) * 180 / Math.PI));
    applySunVector(); text('sun-vector-angle', `${Math.round(elevation)}°`);
  });
  const finish = event => {
    if (!vectorStart || event.pointerId !== vectorStart.id) return;
    if (document.body.hasPointerCapture(event.pointerId)) document.body.releasePointerCapture(event.pointerId);
    vectorStart = null; delete document.body.dataset.drawing; $('sun-vector').setAttribute('hidden', '');
  };
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
  document.body.addEventListener('lostpointercapture', finish);
}
