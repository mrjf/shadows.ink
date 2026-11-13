import { createShadows, isMobileDevice } from './shadows.js';
import conf from './shadows.config.js';

const $ = id => document.getElementById(id);
const mobile = isMobileDevice();
document.body.dataset.device = mobile ? 'mobile' : 'desktop';
if (!mobile) $('about').textContent = 'Move your cursor. Every word and image casts a shadow.';
let pixelsPerMm = conf.pixelsPerMm, calibrationDpr = devicePixelRatio;
const viewportZoom = () => window.visualViewport?.scale ?? 1;
const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
const show = (id, visible) => { if ($(id).hidden === visible) $(id).hidden = !visible; };

const shadows = createShadows($('shadow-page'), {
  ...conf,
  canvas: $('scene'),
  transparent: false,
  onStatus(status) {
    text('mode', status.label);
    text('status', status.mode === 'cursor' ? 'Try on mobile for the true sun angle.' : status.message);
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
