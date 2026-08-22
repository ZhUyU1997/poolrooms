// volumetrics.js —— 天窗/高窗的体积光柱 + 光柱中的尘埃
//
// 做法：按开口矩形沿太阳方向挤出一根棱台（远端略微扩张，模拟散射+太阳张角），
// 加性混合、不写深度。亮度 = 视线穿过体积的近似厚度 |N·V| × 沿程衰减 × 前向散射 × 噪声
// × 软深度（靠近实体表面淡出）× 水面软化（到水面淡出，避免硬相交线）。
// 光柱里的尘埃用 Points + 软圆点，顶点着色器里缓慢漂移（CPU 零开销）。
import * as THREE from 'three';
import { createSoftDotTexture } from './textures.js';

const SHAFT_VERT = /* glsl */`
attribute float aAlong;
attribute float aInt;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vAlong;
varying float vInt;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vNormalW = normalize( mat3( modelMatrix ) * normal );
  vAlong = aAlong;
  vInt = aInt;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHAFT_FRAG = /* glsl */`
precision highp float;
uniform vec3 uCamPos, uSunDir, uColor;
uniform float uTime, uIntensity, uFogDensity, uSubmerged;
uniform sampler2D tNoise, tDepth;
uniform vec2 uRes;
uniform mat4 uInvViewProj;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vAlong;
varying float vInt;

vec3 worldFromDepth( vec2 uv, float rawDepth ) {
  vec4 ndc = vec4( uv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0 );
  vec4 w = uInvViewProj * ndc;
  return w.xyz / w.w;
}

void main() {
  vec3 toCam = uCamPos - vWorld;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );

  // 穿过体积的近似厚度：正对表面时最厚，掠射时趋 0 → 天然软边
  float thick = abs( dot( normalize( vNormalW ), V ) );
  // 沿光柱衰减（越深越淡）
  float fall = exp( -vAlong * 1.7 );
  // 前向散射：视线朝着太阳时更亮
  float fwd = pow( clamp( dot( -V, uSunDir ) * 0.5 + 0.5, 0.0, 1.0 ), 2.2 );
  // 空气不均匀（缓慢流动的噪声）
  float n = texture2D( tNoise, vWorld.xz * 0.09 + vWorld.y * 0.05 + vec2( 0.008, -0.011 ) * uTime ).r;
  n = 0.55 + n * 0.75;

  // 软深度：与实体表面相交处淡出
  vec2 suv = gl_FragCoord.xy / uRes;
  vec3 hit = worldFromDepth( suv, texture2D( tDepth, suv ).x );
  float soft = clamp( ( length( uCamPos - hit ) - dist ) / 1.4, 0.0, 1.0 );
  // 水面软化：到水面(y=0)淡出
  float wf = smoothstep( -0.10, 0.55, vWorld.y );

  float a = thick * fall * fwd * n * soft * wf * uIntensity * vInt;
  a *= ( 1.0 - uSubmerged * 0.75 );
  a *= exp( -pow( dist * uFogDensity * 0.8, 2.0 ) );   // 远处的光柱被雾吃掉
  gl_FragColor = vec4( uColor * a, a );
}
`;

const DUST_VERT = /* glsl */`
attribute float aSeed;
attribute float aScale;
uniform float uTime, uPixelRatio;
varying float vFade;
void main() {
  vec3 p = position;
  float s = aSeed * 6.283;
  // 极缓慢漂移：三个不同频率的正弦，像空气里悬浮的灰尘
  p.x += sin( uTime * 0.13 + s ) * 0.22;
  p.y += sin( uTime * 0.09 + s * 1.7 ) * 0.16 - mod( uTime * 0.02 + aSeed, 1.0 ) * 0.0;
  p.z += cos( uTime * 0.11 + s * 1.3 ) * 0.22;
  vec4 mv = viewMatrix * modelMatrix * vec4( p, 1.0 );
  float d = -mv.z;
  vFade = smoothstep( 0.4, 1.6, d ) * ( 1.0 - smoothstep( 14.0, 26.0, d ) );
  gl_PointSize = aScale * uPixelRatio * ( 34.0 / max( d, 0.6 ) );
  gl_Position = projectionMatrix * mv;
}
`;

const DUST_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tDot;
uniform vec3 uColor;
uniform float uIntensity;
varying float vFade;
void main() {
  float a = texture2D( tDot, gl_PointCoord ).a * vFade * uIntensity;
  if ( a < 0.002 ) discard;
  gl_FragColor = vec4( uColor * a, a );
}
`;

export class Volumetrics {
  constructor(level, sunDir, textures) {
    this.group = new THREE.Group();
    this.group.name = 'volumetrics';
    this.dot = createSoftDotTexture();

    this.shaftUniforms = {
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: sunDir.clone() },
      uColor: { value: new THREE.Color(1.0, 0.965, 0.9) },
      uTime: { value: 0 },
      uIntensity: { value: 0.38 },
      uFogDensity: { value: 0.006 },
      uSubmerged: { value: 0 },
      tNoise: { value: textures.noise },
      tDepth: { value: textures.depth },
      uRes: { value: new THREE.Vector2(1, 1) },
      uInvViewProj: { value: new THREE.Matrix4() },
    };
    this.dustUniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      tDot: { value: this.dot },
      uColor: { value: new THREE.Color(1.0, 0.97, 0.9) },
      uIntensity: { value: 0.75 },
    };

    const shaftMat = new THREE.ShaderMaterial({
      uniforms: this.shaftUniforms,
      vertexShader: SHAFT_VERT,
      fragmentShader: SHAFT_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });
    const dustMat = new THREE.ShaderMaterial({
      uniforms: this.dustUniforms,
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const travel = sunDir.clone().negate().normalize();   // 光行进方向
    const dustPos = [];
    const dustSeed = [];
    const dustScale = [];
    let rnd = mulberry32(20260820);

    for (const s of level.lightShafts) {
      const L = s.axis === 'y' ? 22 : 27;
      const corners = rectCorners(s);
      const center = corners.reduce((a, c) => a.add(c.clone()), new THREE.Vector3()).multiplyScalar(0.25);

      const far = corners.map((c) => {
        const p = c.clone().add(travel.clone().multiplyScalar(L));
        // 远端略扩张（散射 + 太阳张角）
        const farCenter = center.clone().add(travel.clone().multiplyScalar(L));
        return p.sub(farCenter).multiplyScalar(1.09).add(farCenter);
      });

      const pos = [], nor = [], along = [], ints = [], idx = [];
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4];
        const a2 = far[i], b2 = far[(i + 1) % 4];
        const base = pos.length / 3;
        const e1 = b.clone().sub(a), e2 = a2.clone().sub(a);
        const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
        for (const [p, al] of [[a, 0], [b, 0], [b2, 1], [a2, 1]]) {
          pos.push(p.x, p.y, p.z); nor.push(n.x, n.y, n.z); along.push(al);
          ints.push(s.intensity);   // 每根光柱的强度烘进顶点属性（共享一个材质）
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      geo.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
      geo.setAttribute('aInt', new THREE.Float32BufferAttribute(ints, 1));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, shaftMat);
      mesh.name = 'shaft';
      mesh.userData.intensity = s.intensity;
      this.group.add(mesh);

      // 该光柱里的尘埃
      const count = 150;
      for (let i = 0; i < count; i++) {
        const t = Math.pow(rnd(), 0.7) * 0.75;
        const u = rnd(), v = rnd();
        const p = bilerp(corners, u, v).add(travel.clone().multiplyScalar(t * L));
        p.x += (rnd() - 0.5) * 0.5; p.y += (rnd() - 0.5) * 0.5; p.z += (rnd() - 0.5) * 0.5;
        dustPos.push(p.x, p.y, p.z);
        dustSeed.push(rnd());
        dustScale.push(0.35 + rnd() * 0.9);
      }
    }

    const dgeo = new THREE.BufferGeometry();
    dgeo.setAttribute('position', new THREE.Float32BufferAttribute(dustPos, 3));
    dgeo.setAttribute('aSeed', new THREE.Float32BufferAttribute(dustSeed, 1));
    dgeo.setAttribute('aScale', new THREE.Float32BufferAttribute(dustScale, 1));
    dgeo.computeBoundingSphere();
    this.dust = new THREE.Points(dgeo, dustMat);
    this.dust.name = 'dust';
    this.dust.frustumCulled = false;
    this.group.add(this.dust);

    this.shaftMat = shaftMat;
    this.dustMat = dustMat;
  }

  setSize(w, h, pixelRatio) {
    this.shaftUniforms.uRes.value.set(w, h);
    this.dustUniforms.uPixelRatio.value = pixelRatio;
  }

  update(dt, camera, submerged, fogDensity) {
    this.shaftUniforms.uTime.value += dt;
    this.dustUniforms.uTime.value += dt;
    this.shaftUniforms.uCamPos.value.copy(camera.position);
    this.shaftUniforms.uSubmerged.value = submerged;
    this.shaftUniforms.uFogDensity.value = fogDensity;
    const m = this.shaftUniforms.uInvViewProj.value;
    m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
  }

  dispose() {
    this.shaftMat.dispose(); this.dustMat.dispose(); this.dot.dispose();
    this.group.traverse(o => o.geometry?.dispose());
  }
}

// 开口矩形的四个世界角点（按环绕顺序）
function rectCorners(s) {
  const [u0, u1] = s.u, [v0, v1] = s.v, c = s.c;
  const P = s.axis === 'y' ? (u, v) => new THREE.Vector3(u, c, v)
    : s.axis === 'x' ? (u, v) => new THREE.Vector3(c, v, u)
      : (u, v) => new THREE.Vector3(u, v, c);
  return [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
}

function bilerp(c, u, v) {
  const a = c[0].clone().lerp(c[1], u);
  const b = c[3].clone().lerp(c[2], u);
  return a.lerp(b, v);
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
