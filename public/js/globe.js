// VibeTheWorld — WebGL Binary Globe
// Single-pass ray-sphere intersection with binary digit grid rendering

(function () {
  'use strict';

  const canvas = document.getElementById('globe-canvas');
  if (!canvas) return;

  const gl = canvas.getContext('webgl', { alpha: true, antialias: false });
  if (!gl) {
    canvas.style.display = 'none';
    return;
  }

  // --- Shaders ---

  const VERT = `
    attribute vec2 a_pos;
    void main() {
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const FRAG = `
    precision highp float;

    uniform vec2 u_resolution;
    uniform float u_time;
    uniform vec2 u_mouse;

    // Hash — good distribution for noise + digit selection
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // Smooth 2D value noise
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    // Fractal brownian motion — organic continent shapes
    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      vec2 shift = vec2(100.0);
      for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p = p * 2.0 + shift;
        a *= 0.5;
      }
      return v;
    }

    // Domain-warped fbm for natural continent outlines
    float continentNoise(vec2 p) {
      vec2 q = vec2(fbm(p + vec2(1.7, 9.2)), fbm(p + vec2(8.3, 2.8)));
      return fbm(p + 1.8 * q);
    }

    // 3x5 compact bitmap digit — encoded as 15 bits in a float
    // Bit index = col + row*3 (col 0-2, row 0-4)
    float getBit(float bitmap, vec2 p) {
      float idx = p.x + p.y * 3.0;
      return mod(floor(bitmap / pow(2.0, idx)), 2.0);
    }

    float renderDigit(vec2 cellUV, float which) {
      vec2 p = floor(cellUV * vec2(3.0, 5.0));
      if (p.x < 0.0 || p.x >= 3.0 || p.y < 0.0 || p.y >= 5.0) return 0.0;
      // 0 bitmap: .#. / #.# / #.# / #.# / .#.  = 11114.0
      // 1 bitmap: .#. / ##. / .#. / .#. / ### = 29850.0
      float bitmap = which < 0.5 ? 11114.0 : 29850.0;
      return getBit(bitmap, p);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / u_resolution;
      vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

      // Mouse-based tilt (subtle)
      vec2 tilt = (u_mouse - 0.5) * 0.3;

      // Ray origin and direction
      vec3 ro = vec3(0.0, 0.0, 3.0);
      vec3 rd = normalize(vec3(p.x + tilt.x, p.y + tilt.y, -1.5));

      // Sphere at origin, radius 0.85
      float r = 0.85;
      float b = dot(ro, rd);
      float c = dot(ro, ro) - r * r;
      float disc = b * b - c;

      vec3 col = vec3(0.0);

      if (disc > 0.0) {
        float t = -b - sqrt(disc);
        vec3 hit = ro + t * rd;
        vec3 normal = normalize(hit);

        // Sphere UV with rotation
        float rot = u_time * 0.15;
        float theta = atan(normal.x, normal.z) + rot;
        float phi = asin(clamp(normal.y, -1.0, 1.0));

        // --- Continent mask (domain-warped fbm) ---
        vec2 geoUV = vec2(theta / 6.28318 * 6.0, (phi / 3.14159 + 0.5) * 3.0);
        float landNoise = continentNoise(geoUV + vec2(42.0, 17.0));
        float land = smoothstep(0.44, 0.56, landNoise);

        // --- Dense digit grid: 160 cols x 80 rows ---
        float gridCols = 160.0;
        float gridRows = 80.0;
        vec2 gridUV = vec2(
          fract(theta / 6.28318 * gridCols),
          fract((phi / 3.14159 + 0.5) * gridRows)
        );

        vec2 cellID = vec2(
          floor(theta / 6.28318 * gridCols),
          floor((phi / 3.14159 + 0.5) * gridRows)
        );

        // Digit selection — morphs every 2 seconds
        float morphTime = floor(u_time * 0.5);
        float digitSeed = hash(cellID + morphTime * 0.1);
        float which = step(0.5, digitSeed);

        // Render the compact 3x5 digit
        float d = renderDigit(gridUV, which);

        // --- Lighting ---
        vec3 lightDir = normalize(vec3(0.5, 0.8, 1.0));
        float diffuse = max(dot(normal, lightDir), 0.0);
        float ambient = 0.15;
        float light = ambient + diffuse * 0.85;

        // Fresnel rim glow
        float fresnel = pow(1.0 - max(dot(normal, -rd), 0.0), 3.0);

        vec3 green = vec3(0.0, 1.0, 0.255);

        // --- Continent coloring ---
        // Land: bright visible digits. Ocean: very dim, barely visible
        float cellRand = hash(cellID * 7.31);
        float landBright = (0.5 + d * 0.5) * (0.7 + cellRand * 0.3);
        float oceanBright = 0.02 + d * 0.04;
        float brightness = mix(oceanBright, landBright, land);

        col = green * brightness * light;

        // Coastline glow — bright edge where land meets ocean
        float coastDist = abs(landNoise - 0.50);
        float coastGlow = smoothstep(0.08, 0.0, coastDist) * 0.35;
        col += green * coastGlow * light;

        // Rim glow
        col += green * fresnel * 0.4;

        // Scanline effect
        float scanline = sin(gl_FragCoord.y * 1.5) * 0.5 + 0.5;
        col *= 0.92 + 0.08 * scanline;

        // Edge vignette on sphere
        col *= smoothstep(0.0, 0.15, 1.0 - fresnel * 0.5);
      }

      // Ambient glow around sphere
      float dist = length(p);
      float glow = exp(-dist * 3.0) * 0.06;
      col += vec3(0.0, glow, glow * 0.255);

      // Vignette
      float vig = 1.0 - dot(uv - 0.5, uv - 0.5) * 1.2;
      col *= vig;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  // --- WebGL Setup ---

  function createShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vs = createShader(gl.VERTEX_SHADER, VERT);
  const fs = createShader(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { canvas.style.display = 'none'; return; }

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(program));
    canvas.style.display = 'none';
    return;
  }

  gl.useProgram(program);

  // Full-screen quad
  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

  const aPos = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uResolution = gl.getUniformLocation(program, 'u_resolution');
  const uTime = gl.getUniformLocation(program, 'u_time');
  const uMouse = gl.getUniformLocation(program, 'u_mouse');

  // Mouse tracking
  let mouseX = 0.5;
  let mouseY = 0.5;
  document.addEventListener('mousemove', function (e) {
    mouseX = e.clientX / window.innerWidth;
    mouseY = 1.0 - e.clientY / window.innerHeight;
  });

  // Resize
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  window.addEventListener('resize', resize);
  resize();

  // Render loop
  let startTime = performance.now();
  let animId;

  function render() {
    const elapsed = (performance.now() - startTime) / 1000.0;
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, elapsed);
    gl.uniform2f(uMouse, mouseX, mouseY);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    animId = requestAnimationFrame(render);
  }

  // Only animate when hero section is visible
  const hero = document.getElementById('hero');
  const observer = new IntersectionObserver(function (entries) {
    if (entries[0].isIntersecting) {
      if (!animId) {
        startTime = performance.now() - (startTime ? performance.now() - startTime : 0);
        render();
      }
    } else {
      if (animId) {
        cancelAnimationFrame(animId);
        animId = null;
      }
    }
  }, { threshold: 0.1 });

  if (hero) {
    observer.observe(hero);
  }

  // Start immediately
  render();
})();
