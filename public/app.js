'use strict';

/*
 * Simulation de la protanopie en temps réel sur le flux caméra.
 *
 * Les paramètres viennent de libDaltonLens (domaine public) :
 * https://github.com/DaltonLens/libDaltonLens
 * C'est le même code que celui utilisé par https://daltonlens.org/colorblindness-simulator
 *
 * Pipeline par pixel (dans un fragment shader WebGL) :
 *   sRGB -> RGB linéaire -> projection sur le plan de confusion protan -> sRGB
 * Les matrices combinent déjà RGB->LMS, la projection et LMS->RGB.
 */

// Brettel, Viénot & Mollon 1997 — deux demi-plans de projection.
const BRETTEL_PROTAN = {
  m1: [0.14980, 1.19548, -0.34528,
       0.10764, 0.84864,  0.04372,
       0.00384, -0.00540, 1.00156],
  m2: [0.14570, 1.16172, -0.30742,
       0.10816, 0.85291,  0.03892,
       0.00386, -0.00524, 1.00139],
  sepNormal: [0.00048, 0.00393, -0.00441],
};

// Viénot, Brettel & Mollon 1999 — une seule matrice.
const VIENOT_PROTAN = [
  0.11238, 0.88762,  0.00000,
  0.11238, 0.88762, -0.00000,
  0.00401, -0.00401, 1.00000,
];

const VERT = `
attribute vec2 a_pos;
uniform vec2 u_scale;   // recadrage "cover"
uniform float u_mirror; // 1.0 pour la caméra frontale
varying vec2 v_uv;
void main() {
  vec2 uv = a_pos * 0.5 + 0.5;
  uv = 0.5 + (uv - 0.5) * u_scale;
  if (u_mirror > 0.5) uv.x = 1.0 - uv.x;
  v_uv = uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_severity;
uniform int u_algo;        // 0 = Brettel 1997, 1 = Viénot 1999
uniform float u_split;     // fraction de l'écran (à gauche) affichée sans filtre
uniform float u_width;
uniform mat3 u_m1;
uniform mat3 u_m2;
uniform vec3 u_n;
uniform mat3 u_vienot;

vec3 toLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec3 srgb = texture2D(u_tex, v_uv).rgb;
  if (gl_FragCoord.x < u_split * u_width) {
    gl_FragColor = vec4(srgb, 1.0);
    return;
  }
  vec3 rgb = toLinear(srgb);
  vec3 cvd;
  if (u_algo == 0) {
    cvd = dot(rgb, u_n) >= 0.0 ? u_m1 * rgb : u_m2 * rgb;
  } else {
    cvd = u_vienot * rgb;
  }
  cvd = mix(rgb, cvd, u_severity);
  gl_FragColor = vec4(toSRGB(cvd), 1.0);
}`;

// Les matrices C sont en ligne-majeure, GLSL attend du colonne-majeure.
const transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

const $ = (sel) => document.querySelector(sel);
const video = $('#video');
const canvas = $('#gl');
const intro = $('#intro');
const ui = $('#ui');
const errorEl = $('#error');
const divider = $('#divider');

const state = {
  view: 'cvd',       // 'normal' | 'split' | 'cvd'
  algo: 0,
  severity: 1,
  split: 0.5,
  facing: 'environment',
  stream: null,
};

let gl, prog, tex, loc = {};

function initGL() {
  gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false });
  if (!gl) throw new Error("WebGL n'est pas disponible sur ce navigateur.");

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  for (const name of ['u_scale', 'u_mirror', 'u_tex', 'u_severity', 'u_algo', 'u_split',
    'u_width', 'u_m1', 'u_m2', 'u_n', 'u_vienot']) {
    loc[name] = gl.getUniformLocation(prog, name);
  }
  gl.uniformMatrix3fv(loc.u_m1, false, transpose(BRETTEL_PROTAN.m1));
  gl.uniformMatrix3fv(loc.u_m2, false, transpose(BRETTEL_PROTAN.m2));
  gl.uniform3fv(loc.u_n, BRETTEL_PROTAN.sepNormal);
  gl.uniformMatrix3fv(loc.u_vienot, false, transpose(VIENOT_PROTAN));
  gl.uniform1i(loc.u_tex, 0);

  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function draw() {
  if (video.readyState < 2 || !video.videoWidth) return false;
  resize();
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);

  const va = video.videoWidth / video.videoHeight;
  const ca = canvas.width / canvas.height;
  const scale = va > ca ? [ca / va, 1] : [1, va / ca];
  gl.uniform2fv(loc.u_scale, scale);
  gl.uniform1f(loc.u_mirror, state.facing === 'user' ? 1 : 0);
  gl.uniform1f(loc.u_severity, state.severity);
  gl.uniform1i(loc.u_algo, state.algo);
  gl.uniform1f(loc.u_width, canvas.width);
  const split = state.view === 'normal' ? 1.01 : state.view === 'split' ? state.split : 0;
  gl.uniform1f(loc.u_split, split);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return true;
}

function loop() {
  draw();
  requestAnimationFrame(loop);
}

async function startCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: state.facing },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  state.stream = stream;
  video.srcObject = stream;
  await video.play();
}

function explain(err) {
  if (!window.isSecureContext) return 'La caméra nécessite une connexion HTTPS.';
  if (!navigator.mediaDevices?.getUserMedia) return "Votre navigateur ne permet pas l'accès à la caméra.";
  switch (err?.name) {
    case 'NotAllowedError': return "Accès à la caméra refusé. Autorisez-le dans les réglages du navigateur puis réessayez.";
    case 'NotFoundError': return 'Aucune caméra trouvée sur cet appareil.';
    case 'NotReadableError': return 'La caméra est déjà utilisée par une autre application.';
    default: return `Impossible de démarrer : ${err?.message || err}`;
  }
}

// ---- Interface ----

function setPressed(groupAttr, value) {
  document.querySelectorAll(`[${groupAttr}]`).forEach((b) => {
    b.setAttribute('aria-pressed', String(b.getAttribute(groupAttr) === String(value)));
  });
}

function setView(view) {
  state.view = view;
  setPressed('data-view', view);
  const split = view === 'split';
  divider.classList.toggle('on', split);
  $('#lblLeft').classList.toggle('on', split);
  $('#lblRight').classList.toggle('on', split);
  divider.style.left = `${state.split * 100}%`;
}

document.querySelectorAll('[data-view]').forEach((b) =>
  b.addEventListener('click', () => setView(b.dataset.view)));

document.querySelectorAll('[data-algo]').forEach((b) =>
  b.addEventListener('click', () => {
    state.algo = Number(b.dataset.algo);
    setPressed('data-algo', state.algo);
  }));

$('#severity').addEventListener('input', (e) => {
  state.severity = e.target.value / 100;
  $('#sevOut').textContent = `${e.target.value} %`;
});

divider.addEventListener('pointerdown', (e) => {
  divider.setPointerCapture(e.pointerId);
  const move = (ev) => {
    state.split = Math.min(0.95, Math.max(0.05, ev.clientX / window.innerWidth));
    divider.style.left = `${state.split * 100}%`;
  };
  const up = () => {
    divider.removeEventListener('pointermove', move);
    divider.removeEventListener('pointerup', up);
    divider.removeEventListener('pointercancel', up);
  };
  divider.addEventListener('pointermove', move);
  divider.addEventListener('pointerup', up);
  divider.addEventListener('pointercancel', up);
});

$('#flip').addEventListener('click', async () => {
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  try { await startCamera(); } catch (err) { alert(explain(err)); }
});

$('#snap').addEventListener('click', () => {
  // Redessine puis capture dans la même tâche (le buffer WebGL n'est pas conservé).
  if (!draw()) return;
  canvas.toBlob(async (blob) => {
    if (!blob) return;
    const name = `protanopie-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Vision protanope' }); return; } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
});

$('#start').addEventListener('click', async () => {
  errorEl.textContent = '';
  try {
    if (!gl) initGL();
    await startCamera();
    intro.style.display = 'none';
    ui.classList.add('on');
    setView(state.view);
    loop();
  } catch (err) {
    console.error(err);
    errorEl.textContent = explain(err);
  }
});

window.addEventListener('resize', () => { if (state.view === 'split') divider.style.left = `${state.split * 100}%`; });
