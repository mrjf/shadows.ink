// The distance field is derived from the current silhouette and rebuilt when it changes.
export function signedDistanceField(alpha, width, height, texelsPerUnit = 1) {
  const outside = new Float64Array(width * height), inside = new Float64Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    const coverage = alpha[i] / 255;
    outside[i] = coverage === 1 ? 0 : coverage === 0 ? 1e12 : Math.max(0, .5 - coverage) ** 2;
    inside[i] = coverage === 0 ? 0 : coverage === 1 ? 1e12 : Math.max(0, coverage - .5) ** 2;
  }
  const size = Math.max(width, height), f = new Float64Array(size), d = new Float64Array(size);
  const sites = new Int32Array(size), edges = new Float64Array(size + 1);
  function transform(length) {
    let k = 0; sites[0] = 0; edges[0] = -Infinity; edges[1] = Infinity;
    for (let q = 1; q < length; q++) {
      let s = ((f[q] + q * q) - (f[sites[k]] + sites[k] * sites[k])) / (2 * (q - sites[k]));
      while (s <= edges[k] && k > 0) {
        k--; s = ((f[q] + q * q) - (f[sites[k]] + sites[k] * sites[k])) / (2 * (q - sites[k]));
      }
      k++; sites[k] = q; edges[k] = s; edges[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < length; q++) { while (edges[k + 1] < q) k++; d[q] = (q - sites[k]) ** 2 + f[sites[k]]; }
  }
  for (const grid of [outside, inside]) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
      transform(height);
      for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) f[x] = grid[y * width + x];
      transform(width);
      for (let x = 0; x < width; x++) grid[y * width + x] = d[x];
    }
  }
  const field = new Uint8Array(width * height * 2);
  for (let i = 0; i < alpha.length; i++) {
    const distance = (Math.sqrt(outside[i]) - Math.sqrt(inside[i])) / texelsPerUnit;
    const encoded = Math.round(Math.max(0, Math.min(1, distance / 1024 + .5)) * 65535);
    field[i * 2] = encoded >> 8; field[i * 2 + 1] = encoded & 255;
  }
  return field;
}

const vertex = `#version 300 es
precision highp float;
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0, 1);
}`;
const fragment = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outputColor;
uniform sampler2D glyph;
uniform vec2 size, patternOffset;
uniform vec3 sun, skyUp, lightPosition;
uniform float gapMm, thicknessMm, pixelsPerMm, angularRadius, sunlight;
uniform int materialId, usePointLight, shadowOnly;
const float PI = 3.14159265359;
// World positions and distances are millimeters. Raster units enter only at glyph sampling.
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}
float layeredNoise(vec2 p) {
  mat2 turn = mat2(.8,.6,-.6,.8);
  float value = .57*noise(p);
  p = turn*p*2.07 + vec2(13.2,7.9); value += .28*noise(p);
  p = turn*p*2.11 + vec2(5.4,19.1); value += .15*noise(p);
  return value;
}
float glassRipples(vec2 p) {
  vec2 q = p*.37;
  vec2 warp = vec2(layeredNoise(q*.51),layeredNoise(q*.51+vec2(18.3,4.7)))-.5;
  return layeredNoise(q+warp*3.4);
}
float woodGrain(vec2 p) {
  vec2 cell = floor(p/vec2(18,32));
  vec2 center = (cell+.4+.2*vec2(hash(cell),hash(cell+vec2(7,19))))*vec2(18,32);
  vec2 knot = (p-center)/vec2(2.8,5.0);
  float bent = p.x + 2.3*(layeredNoise(p*vec2(.11,.06))-.5) + 3.0*knot.x*exp(-dot(knot,knot));
  return .68*noise(vec2(bent*2.6,p.y*.045)) + .32*noise(vec2(bent*7.4,p.y*.17));
}
float textureHeight(vec2 p) {
  if (materialId == 1) {
    vec2 warp = vec2(noise(p*.23),noise(p*.23+vec2(9,17)))-.5;
    return -.09*layeredNoise(p*.62) - .035*noise(p*7.7) - .055*smoothstep(.63,.88,noise(p*2.4+warp));
  }
  if (materialId == 2) return .34*glassRipples(p);
  return .055*woodGrain(p) + .012*noise(p*vec2(4.0,.25));
}
float graphLines(vec2 p, float spacing, float halfWidth) {
  vec2 distance = abs(mod(p+spacing*.5,spacing)-spacing*.5);
  float feather = .7/pixelsPerMm;
  return 1.0-smoothstep(halfWidth,halfWidth+feather,min(distance.x,distance.y));
}
vec3 shadowTexture(vec2 p) {
  if (materialId == 4) {
    float minor = graphLines(p,1.0,.018), major = graphLines(p,5.0,.035);
    return mix(vec3(.99,1.0,1.01),vec3(.61,.77,.91),max(minor*.46,major*.8));
  }
  p += patternOffset;
  const float stepMm = .04;
  vec3 normal = normalize(vec3(textureHeight(p-vec2(stepMm,0))-textureHeight(p+vec2(stepMm,0)),
    textureHeight(p-vec2(0,stepMm))-textureHeight(p+vec2(0,stepMm)), 2.0*stepMm));
  // An appearance effect revealed by the cast shadow, not a refractive receiver simulation.
  vec3 tint;
  if (materialId == 1) {
    float aggregate = layeredNoise(p*.63), grain = noise(p*7.7);
    float pores = smoothstep(.68,.9,noise(p*2.4+vec2(noise(p*.2),noise(p*.2+11.7))));
    tint = vec3(.94,.98,1.02)*(.7+.31*aggregate+.26*grain-.14*pores);
  } else if (materialId == 2) {
    float waves = glassRipples(p);
    float ribbon = pow(1.0-abs(2.0*waves-1.0),8.0);
    tint = vec3(.82,.98,1.12)*(.73+.45*waves+.19*ribbon);
  } else {
    float grain = woodGrain(p);
    float pores = smoothstep(.7,.9,noise(p*vec2(11,.36)));
    tint = mix(vec3(.69,.5,.32),vec3(1.18,.99,.72),smoothstep(.15,.85,grain)) * (1.0-.13*pores);
  }
  vec3 reliefLight = normalize(vec3(-.35,.45,.8) + skyUp*.3);
  float relief = .84 + .16*normal.z + .3*(dot(normal,reliefLight)-reliefLight.z);
  return tint * relief;
}
float glyphDistance(vec2 p) {
  vec2 encoded = texture(glyph, vec2(p.x / size.x, 1.0 - p.y / size.y)).rg;
  return (dot(encoded, vec2(65280.0,255.0)) / 65535.0 - .5) * 1024.0 / pixelsPerMm;
}
float letterDistance(vec3 p) {
  float bevel = min(.16, thicknessMm * .2);
  vec2 d = vec2(glyphDistance(p.xy) + bevel, abs(p.z-gapMm-thicknessMm*.5) - thicknessMm*.5 + bevel);
  return length(max(d,0.0)) + min(max(d.x,d.y),0.0) - bevel;
}
float visibility(vec3 origin, vec3 direction, float maxTravel) {
  // Zero gap and thickness is ink on the receiver.
  if (gapMm == 0.0 && thicknessMm == 0.0) return 1.0;
  if (direction.z <= .00001) return 1.0;
  if (thicknessMm <= 0.0) {
    float travel = (gapMm-origin.z) / direction.z;
    if (travel <= .000025 || travel >= maxTravel) return 1.0;
    vec2 p = origin.xy + direction.xy * travel;
    if (p.x < 0.0 || p.y < 0.0 || p.x > size.x || p.y > size.y) return 1.0;
    return glyphDistance(p) < 0.0 ? 0.0 : 1.0;
  }
  float begin = max(.02, (gapMm-origin.z) / direction.z - .13);
  float end = min(maxTravel,(gapMm+thicknessMm-origin.z) / direction.z + .265);
  float travel = begin;
  for (int i=0; i<72; i++) {
    if (travel > end) return 1.0;
    vec3 p = origin + direction * travel;
    if (p.x < 0.0 || p.y < 0.0 || p.x > size.x || p.y > size.y) return 1.0;
    float distance = letterDistance(p);
    if (distance < .02) return 0.0;
    travel += max(.02, distance * .85);
  }
  // The 0.02 mm hit tolerance and step limit are numerical approximations, not blur.
  return 1.0;
}
vec3 diskDirection(int index, vec3 origin, out float travel) {
  float r = sqrt((float(index)+.5) / 12.0);
  float a = float(index) * 2.39996322973;
  vec3 center = usePointLight == 1 ? normalize(lightPosition-origin) : sun;
  vec3 right = normalize(cross(center, abs(center.z) < .95 ? vec3(0,0,1) : vec3(0,1,0)));
  vec3 up = cross(right,center);
  vec3 disk = r * (cos(a)*right + sin(a)*up);
  if (usePointLight == 1) {
    // A fixed-radius source subtends less of the sky farther from the cursor.
    vec3 sampleVector = lightPosition-origin + tan(angularRadius)*lightPosition.z*disk;
    travel = length(sampleVector);
    return sampleVector/travel;
  }
  travel = 1e20;
  return normalize(sun + angularRadius*disk);
}
vec3 brdf(vec3 albedo, vec3 normal, vec3 light, float roughness) {
  float nl = max(dot(normal,light),0.0), nv = max(normal.z,.001);
  if (nl <= 0.0) return vec3(0);
  vec3 halfway = normalize(light + vec3(0,0,1));
  float nh = max(dot(normal,halfway),0.0), vh = max(halfway.z,0.0);
  float a2 = pow(roughness,4.0);
  float distribution = a2 / (PI * pow(nh*nh*(a2-1.0)+1.0,2.0));
  float k = pow(roughness+1.0,2.0) / 8.0;
  float geometry = nl/(nl*(1.0-k)+k) * nv/(nv*(1.0-k)+k);
  vec3 fresnel = vec3(.04) + .96 * pow(1.0-vh,5.0);
  return ((1.0-fresnel)*albedo/PI + distribution*geometry*fresnel/max(4.0*nl*nv,.001)) * nl;
}
void main() {
  vec2 p = uv * size;
  vec3 normal = vec3(0,0,1), albedo = vec3(.72,.67,.57), origin = vec3(p,.005);
  vec3 direct = vec3(0), unoccludedDirect = vec3(0);
  float blockedLight = 0.0, incidentLight = 0.0;
  for (int i=0; i<12; i++) {
    float travel;
    vec3 direction = diskDirection(i,origin,travel);
    float visible = visibility(origin,direction,travel);
    float attenuation = usePointLight == 1 ? lightPosition.z*lightPosition.z/(travel*travel) : 1.0;
    vec3 incidentColor = brdf(albedo,normal,direction,.24)*attenuation;
    direct += incidentColor*visible;
    unoccludedDirect += incidentColor;
    float incident = max(direction.z,0.0)*attenuation;
    blockedLight += incident*(1.0-visible); incidentLight += incident;
  }
  direct *= sunlight / 12.0;
  // This pass shades only the receiver. Letter coverage never changes its lighting branch.
  vec3 ambient = albedo * (.12 + .32*(.5+.5*dot(normal,skyUp)));
  vec3 unoccluded = unoccludedDirect*sunlight/12.0 + ambient;
  float openSky = 0.0;
  for (int i=0; i<32; i++) {
    float a = (float(i)+.5)*2.39996323;
    float r = sqrt((float(i)+.5)/32.0);
    vec3 direction = vec3(cos(a)*r,sin(a)*r,sqrt(1.0-r*r));
    openSky += visibility(origin,direction,1e20);
  }
  ambient *= .25 + .75 * openSky / 32.0;
  vec3 linear = direct + ambient;
  if (shadowOnly == 1) {
    vec3 weights = vec3(.2126,.7152,.0722);
    float transmission = clamp(dot(linear,weights)/max(dot(unoccluded,weights),.00001),0.0,1.0);
    vec3 ink = vec3(0);
    float opacity = 1.0-pow(transmission,1.0/2.2);
    if (materialId != 0 && sunlight > 0.0 && blockedLight > 0.0) {
      vec3 textureColor = shadowTexture(p);
      float shadow = clamp(blockedLight/max(incidentLight,.00001),0.0,1.0);
      opacity = clamp(opacity*mix(1.0,1.25-dot(textureColor,weights)*.25,shadow),0.0,1.0);
      ink = max(textureColor-vec3(min(textureColor.r,min(textureColor.g,textureColor.b))),vec3(0))*.25;
    }
    outputColor = vec4(ink,opacity);
    return;
  }
  if (materialId != 0 && sunlight > 0.0 && (usePointLight == 1 || sun.z > 0.0) && blockedLight > 0.0) {
    float shadow = clamp(blockedLight / max(incidentLight,.00001),0.0,1.0);
    linear *= mix(vec3(1),shadowTexture(p),shadow);
  }
  vec3 mapped = clamp((linear*(2.51*linear+.03))/(linear*(2.43*linear+.59)+.14),0.0,1.0);
  vec3 srgb = mix(mapped*12.92, 1.055*pow(mapped,vec3(1.0/2.4))-.055, step(vec3(.0031308),mapped));
  outputColor = vec4(srgb,1);
}`;

const composite = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outputColor;
uniform sampler2D receiver, coverage;
uniform vec3 letterColor;
uniform int shadowOnly;
void main() {
  float alpha = texture(coverage,vec2(uv.x,1.0-uv.y)).r;
  vec4 surface = texture(receiver,uv);
  if (shadowOnly == 1) {
    float opacity = alpha+surface.a*(1.0-alpha);
    vec3 color = (letterColor*alpha+surface.rgb*surface.a*(1.0-alpha))/max(opacity,.00001);
    outputColor = vec4(color,opacity);
  } else outputColor = vec4(mix(surface.rgb,letterColor,alpha),1);
}`;

function drawMask(width, height, rasterWidth, rasterHeight, paint) {
  const mask = document.createElement('canvas'); mask.width = rasterWidth; mask.height = rasterHeight;
  const ctx = mask.getContext('2d', { willReadFrequently: true });
  ctx.scale(rasterWidth/width,rasterHeight/height);
  ctx.fillStyle = '#fff';
  paint(ctx,width,height);
  let pixels;
  try { pixels = ctx.getImageData(0,0,rasterWidth,rasterHeight).data; }
  catch { throw new Error('A shadow image cannot be read. Use an image hosted on this site or one that permits cross-origin image access.'); }
  const alpha = new Uint8Array(rasterWidth*rasterHeight);
  for (let i=0;i<alpha.length;i++) alpha[i] = pixels[i*4+3];
  return alpha;
}

function roundedElement(ctx,rect,style,origin) {
  const radius = value => {
    const parts = value.split(' '), x = parts[0], y = parts[1] || x;
    return { x: parseFloat(x)*(x.endsWith('%') ? rect.width/100 : 1), y: parseFloat(y)*(y.endsWith('%') ? rect.height/100 : 1) };
  };
  ctx.beginPath();
  ctx.roundRect(rect.left-origin.left,rect.top-origin.top,rect.width,rect.height,
    [style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomRightRadius,style.borderBottomLeftRadius].map(radius));
}

function paintText(ctx,element,origin) {
  const walker = document.createTreeWalker(element,NodeFilter.SHOW_TEXT), range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const style = getComputedStyle(node.parentElement);
    if (style.display === 'none' || style.visibility !== 'visible') continue;
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.fontKerning = style.fontKerning;
    ctx.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
    ctx.wordSpacing = style.wordSpacing === 'normal' ? '0px' : style.wordSpacing;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.direction = style.direction;
    const descent = ctx.measureText('Mg').fontBoundingBoxDescent;
    let line = null;
    const flush = () => {
      if (!line) return;
      const text = style.textTransform === 'uppercase' ? line.text.toUpperCase() : style.textTransform === 'lowercase' ? line.text.toLowerCase() : line.text;
      ctx.fillText(text,line.left-origin.left,line.bottom-origin.top-descent);
    };
    let offset = 0;
    for (const character of node.textContent) {
      range.setStart(node,offset); offset += character.length; range.setEnd(node,offset);
      const rect = range.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (!line || Math.abs(line.top-rect.top) > .5) {
        flush(); line = { text: '', left: rect.left, top: rect.top, bottom: rect.bottom };
      }
      line.text += /\s/.test(character) && style.whiteSpace === 'normal' ? ' ' : character;
    }
    flush();
  }
}

/** Paint supported, untransformed DOM silhouettes; foreground stays in the DOM. */
export function drawElementMask(ctx,root,selector = '.shadows-ink') {
  const origin = root.getBoundingClientRect();
  for (const element of root.querySelectorAll(selector)) {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || style.display === 'none' || style.visibility !== 'visible') continue;
    if (style.transform !== 'none') throw new Error('Shadow elements must not use CSS transforms. Supply a custom mask for transformed shapes.');
    ctx.save(); ctx.fillStyle = '#fff';
    const kind = element.dataset.shadowShape || (element instanceof HTMLImageElement ? 'image' : 'text');
    if (kind === 'box') { roundedElement(ctx,rect,style,origin); ctx.fill(); }
    else if (kind === 'image') {
      if (!(element instanceof HTMLImageElement) || !element.complete || !element.naturalWidth) throw new Error('A shadow image has not loaded. Reload the page to try again.');
      roundedElement(ctx,rect,style,origin); ctx.clip();
      const width = rect.width, height = rect.height, naturalWidth = element.naturalWidth, naturalHeight = element.naturalHeight;
      let scaleX = width/naturalWidth, scaleY = height/naturalHeight;
      if (style.objectFit === 'cover') scaleX = scaleY = Math.max(scaleX,scaleY);
      else if (style.objectFit === 'contain') scaleX = scaleY = Math.min(scaleX,scaleY);
      else if (style.objectFit === 'none') scaleX = scaleY = 1;
      else if (style.objectFit === 'scale-down') scaleX = scaleY = Math.min(1,scaleX,scaleY);
      const positions = style.objectPosition.split(' ');
      const position = (value,space) => value.endsWith('%') ? space*parseFloat(value)/100 : parseFloat(value);
      const x = rect.left-origin.left+position(positions[0],width-naturalWidth*scaleX);
      const y = rect.top-origin.top+position(positions[1],height-naturalHeight*scaleY);
      ctx.drawImage(element,x,y,naturalWidth*scaleX,naturalHeight*scaleY);
    } else if (kind === 'text') paintText(ctx,element,origin);
    else throw new Error(`Unsupported shadow element: ${kind}. Supply a custom mask for this shape.`);
    ctx.restore();
  }
}

function letterFaceColor(light, skyUp, sunlight) {
  // A planar opaque face has one lighting value; its outline comes only from native glyph coverage.
  const nl = Math.max(0,light[2]), roughness = .72;
  let specular = 0, fresnel = .04;
  if (nl > 0) {
    const halfLength = Math.hypot(light[0],light[1],light[2]+1), nh = (light[2]+1)/halfLength;
    const a2 = roughness**4, distribution = a2/(Math.PI*(nh*nh*(a2-1)+1)**2);
    const k = (roughness+1)**2/8, geometry = nl/(nl*(1-k)+k);
    fresnel += .96*(1-nh)**5;
    specular = distribution*geometry*fresnel/4;
  }
  const ambient = .12 + .32*(.5+.5*skyUp[2]);
  return [.036,.031,.024].map(albedo => {
    const linear = ((1-fresnel)*albedo/Math.PI*nl + specular)*sunlight + albedo*ambient;
    const mapped = Math.max(0,Math.min(1,(linear*(2.51*linear+.03))/(linear*(2.43*linear+.59)+.14)));
    return mapped <= .0031308 ? mapped*12.92 : 1.055*mapped**(1/2.4)-.055;
  });
}

export class SunRenderer {
  constructor(canvas, { paintMask, compositeForeground = true, transparent = false } = {}) {
    this.canvas = canvas;
    if (typeof paintMask !== 'function') throw new TypeError('paintMask must be a canvas drawing function.');
    this.paintMask = paintMask; this.compositeForeground = compositeForeground; this.maskDirty = true;
    this.transparent = transparent;
    const gl = canvas.getContext('webgl2', { alpha: transparent, premultipliedAlpha: false, antialias: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('This browser can’t render the scene. Open this link directly in Safari or Chrome with WebGL enabled.');
    this.gl = gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(shader)); gl.deleteShader(shader); throw new Error('The graphics could not start. Reload this page directly in Safari or Chrome.'); }
      return shader;
    };
    const link = source => {
      const vs = compile(gl.VERTEX_SHADER,vertex), fs = compile(gl.FRAGMENT_SHADER,source);
      const program = gl.createProgram(); gl.attachShader(program,vs); gl.attachShader(program,fs); gl.linkProgram(program);
      gl.deleteShader(vs); gl.deleteShader(fs);
      if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error('The shadow renderer could not start. Reload this page in Safari or Chrome.');
      return program;
    };
    this.program = link(fragment); this.compositeProgram = link(composite);
    // One realization per renderer; movement and resizing never regenerate the surface.
    this.patternOffset = Float32Array.from(crypto.getRandomValues(new Uint32Array(2)), value => value/4294967296*256);
    this.uniforms = Object.fromEntries(['glyph','size','patternOffset','sun','skyUp','lightPosition','usePointLight','gapMm','thicknessMm','pixelsPerMm','angularRadius','sunlight','materialId','shadowOnly'].map(name => [name,gl.getUniformLocation(this.program,name)]));
    this.compositeUniforms = Object.fromEntries(['receiver','coverage','letterColor','shadowOnly'].map(name => [name,gl.getUniformLocation(this.compositeProgram,name)]));
    const texture = () => {
      const value = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,value);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      return value;
    };
    this.texture = texture(); this.coverageTexture = texture(); this.receiverTexture = texture();
    this.receiverFramebuffer = gl.createFramebuffer();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    this.resize();
  }
  resize() {
    const width = Math.max(1,Math.round(this.canvas.clientWidth)), height = Math.max(1,Math.round(this.canvas.clientHeight));
    const density = devicePixelRatio;
    if (width === this.width && height === this.height && density === this.density && !this.maskDirty) return;
    this.width = width; this.height = height; this.density = density;
    this.canvas.width = Math.round(width*density); this.canvas.height = Math.round(height*density);
    this.shadowWidth = Math.max(1,Math.round(width*Math.min(density,1.25)));
    this.shadowHeight = Math.max(1,Math.round(height*Math.min(density,1.25)));
    const maskScale = 2, maskWidth = width*maskScale, maskHeight = height*maskScale;
    const alpha = drawMask(width,height,maskWidth,maskHeight,this.paintMask);
    const field = signedDistanceField(alpha,maskWidth,maskHeight,maskScale);
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,this.texture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RG8,maskWidth,maskHeight,0,gl.RG,gl.UNSIGNED_BYTE,field);
    gl.bindTexture(gl.TEXTURE_2D,this.coverageTexture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.R8,this.canvas.width,this.canvas.height,0,gl.RED,gl.UNSIGNED_BYTE,
      this.compositeForeground ? drawMask(width,height,this.canvas.width,this.canvas.height,this.paintMask) : new Uint8Array(this.canvas.width*this.canvas.height));
    gl.bindTexture(gl.TEXTURE_2D,this.receiverTexture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,this.shadowWidth,this.shadowHeight,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.receiverFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.receiverTexture,0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The shadow surface could not start. Reload this page directly in Safari or Chrome.');
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindTexture(gl.TEXTURE_2D,this.texture);
    gl.viewport(0,0,this.canvas.width,this.canvas.height);
    this.maskDirty = false;
  }
  invalidateMask() { this.maskDirty = true; }
  draw({ light, lightPositionMm = null, skyUp = [0,0,1], gapMm, thicknessMm, pixelsPerMm, material, daylight, angularRadius = .00465, altitude = 35 }) {
    if (!Number.isFinite(gapMm) || gapMm < 0 || !Number.isFinite(thicknessMm) || thicknessMm < 0
      || !Number.isFinite(pixelsPerMm) || pixelsPerMm <= 0) {
      throw new RangeError('Gap and thickness must be nonnegative millimeters, and screen scale must be positive pixels per millimeter.');
    }
    if (lightPositionMm !== null && (lightPositionMm.length !== 3 || !Array.from(lightPositionMm).every(Number.isFinite) || lightPositionMm[2] <= 0)) {
      throw new RangeError('The light position must contain three finite millimeter coordinates with a positive height above the surface.');
    }
    const materials = { smooth: 0, concrete: 1, glass: 2, wood: 3, graph: 4 };
    if (!Object.hasOwn(materials,material)) throw new RangeError(`Unknown shadow texture: ${material}.`);
    this.resize();
    const gl = this.gl, u = this.uniforms;
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.receiverFramebuffer);
    gl.viewport(0,0,this.shadowWidth,this.shadowHeight);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,this.texture);
    gl.useProgram(this.program);
    gl.uniform1i(u.glyph,0); gl.uniform2f(u.size,this.width/pixelsPerMm,this.height/pixelsPerMm);
    gl.uniform2fv(u.patternOffset,this.patternOffset);
    gl.uniform3fv(u.sun,light); gl.uniform3fv(u.skyUp,skyUp);
    gl.uniform1i(u.usePointLight,lightPositionMm === null ? 0 : 1);
    gl.uniform1i(u.shadowOnly,this.transparent ? 1 : 0);
    gl.uniform3fv(u.lightPosition,lightPositionMm ?? [0,0,1]);
    gl.uniform1f(u.gapMm,gapMm); gl.uniform1f(u.thicknessMm,thicknessMm); gl.uniform1f(u.pixelsPerMm,pixelsPerMm);
    gl.uniform1f(u.angularRadius,angularRadius); gl.uniform1i(u.materialId,materials[material]);
    const airMass = 1/(Math.sin(Math.max(0,altitude)*Math.PI/180)+.50572*(Math.max(0,altitude)+6.07995)**-1.6364);
    const sunlight = daylight ? 4.5*Math.exp(-.14*(airMass-1)) : 0;
    gl.uniform1f(u.sunlight,sunlight);
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.viewport(0,0,this.canvas.width,this.canvas.height);
    gl.useProgram(this.compositeProgram);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,this.receiverTexture);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,this.coverageTexture);
    const c = this.compositeUniforms;
    gl.uniform1i(c.receiver,0); gl.uniform1i(c.coverage,1);
    gl.uniform1i(c.shadowOnly,this.transparent ? 1 : 0);
    gl.uniform3fv(c.letterColor,letterFaceColor(light,skyUp,sunlight));
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,this.texture);
    gl.useProgram(this.program);
    this.canvas.dataset.frame = String(Number(this.canvas.dataset.frame ?? 0)+1);
    this.canvas.dataset.lit = String(daylight && (lightPositionMm !== null || light[2] > 0));
  }
  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.texture); gl.deleteTexture(this.coverageTexture); gl.deleteTexture(this.receiverTexture);
    gl.deleteFramebuffer(this.receiverFramebuffer); gl.deleteProgram(this.program); gl.deleteProgram(this.compositeProgram);
  }
}
