const rad = Math.PI / 180;
const degrees = x => x / rad;
const wrap = x => ((x % 360) + 360) % 360;

// NOAA solar equations; vectors use east, north, up and geographic north.
export function sunPosition(date, latitude, longitude) {
  const t = (date.getTime() / 86400000 + 2440587.5 - 2451545) / 36525;
  const l = wrap(280.46646 + t * (36000.76983 + t * 0.0003032));
  const m = (357.52911 + t * (35999.05029 - 0.0001537 * t)) * rad;
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * m) * (0.019993 - 0.000101 * t) + Math.sin(3 * m) * 0.000289;
  const omega = (125.04 - 1934.136 * t) * rad;
  const apparent = (l + c - 0.00569 - 0.00478 * Math.sin(omega)) * rad;
  const obliquity = (23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
    + 0.00256 * Math.cos(omega)) * rad;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparent));
  const y = Math.tan(obliquity / 2) ** 2;
  const equation = 4 * degrees(y * Math.sin(2 * l * rad) - 2 * e * Math.sin(m)
    + 4 * e * y * Math.sin(m) * Math.cos(2 * l * rad) - 0.5 * y * y * Math.sin(4 * l * rad)
    - 1.25 * e * e * Math.sin(2 * m));
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const hour = (wrap((minutes + equation + 4 * longitude) / 4) - 180) * rad;
  const lat = latitude * rad;
  const vector = [
    -Math.cos(declination) * Math.sin(hour),
    Math.cos(lat) * Math.sin(declination) - Math.sin(lat) * Math.cos(declination) * Math.cos(hour),
    Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hour),
  ];
  const distanceAU = 1.000001018 * (1 - e * e) / (1 + e * Math.cos(m + c * rad));
  return { vector, azimuth: wrap(degrees(Math.atan2(vector[0], vector[1]))), altitude: degrees(Math.asin(vector[2])), angularRadius: Math.asin(.00465047 / distanceAU) };
}

// W3C intrinsic Z-X′-Y″ rotation, transposed to put the world sun in device space.
export function screenLight(vector, { alpha, beta, gamma }, screenAngle = 0) {
  const a = alpha * rad, b = beta * rad, g = gamma * rad;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  const [e, n, u] = vector;
  const x = (ca * cg - sa * sb * sg) * e + (sa * cg + ca * sb * sg) * n - cb * sg * u;
  const y = -sa * cb * e + ca * cb * n + sb * u;
  const z = (ca * sg + sa * sb * cg) * e + (sa * sg - ca * sb * cg) * n + cb * cg * u;
  const angle = screenAngle * rad;
  // The UI compensates clockwise for a counter-clockwise screen orientation.
  return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), z];
}

export function compassOffset(reading) {
  // Safari's compass is used only face-up, where its heading and the top edge agree.
  if (!Number.isFinite(reading.webkitCompassHeading) || reading.webkitCompassHeading < 0
    || Math.abs(reading.beta) > 25 || Math.abs(reading.gamma) > 25
    || !Number.isFinite(reading.alpha) || (Number.isFinite(reading.webkitCompassAccuracy)
      && (reading.webkitCompassAccuracy < 0 || reading.webkitCompassAccuracy > 30))) return null;
  return -reading.webkitCompassHeading - reading.alpha;
}
