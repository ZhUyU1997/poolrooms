// water.js —— 水面系统：单平面反射 + 折射 + 吸收 + caustics + 水下状态
//
// 关键取舍与依据：
// 1) 全场水面恒在 y=0 → **一次**平面反射即可服务所有水域（省一次全场景渲染）。
// 2) 水面材质是**不透明**的：它自己把折射色与反射色混合好后输出，因此不需要 alpha 混合、
//    没有透明排序问题；代价是 GTAO 会把它当不透明面 → main.js 用一个不含水面的 AO 场景解决。
// 3) 折射目标附带 **FloatType 深度纹理**，用逆 viewProj 反算池底世界坐标：
//      · 光在水中的行程 = |池底点 - 水面点| → Beer-Lambert 吸收（红光先死 → 天然青绿渐变）
//      · 池底世界 xz 采样 caustic 贴图 → 光斑自动贴合任何池底几何，不用改池底材质
//    反算命中点若高于水面（掠射角看到水上墙面），行程按 0 处理（避免 exp(-σd) 变增亮）。
// 4) 反射相机用官方 Reflector 的斜近平面(oblique near plane)技巧做水面裁剪，
//    **不动 renderer.clippingPlanes**（否则会污染阴影 pass）。水下时平面法线翻转。
import * as THREE from 'three';
import { createRippleNormal, createCausticTexture } from './textures.js';

const RIPPLE_SLOTS = 4;

const VERT = /* glsl */`
uniform mat4 uTextureMatrix;
attribute float aCaustic;
attribute float aTint;
varying vec3 vWorld;
varying vec4 vReflectUV;
varying float vCaustic;
varying float vTint;
varying float vViewZ;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vReflectUV = uTextureMatrix * wp;
  vCaustic = aCaustic;
  vTint = aTint;
  vViewZ = -( viewMatrix * wp ).z;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D tReflect, tRefract, tRefractDepth, tRipple, tCaustic;
uniform vec2 uResolution;
uniform vec3 uCamPos, uSunDir, uSunColor, uAbsorb, uFogColor, uSkyTint;
uniform float uTime, uSubmerged, uFogDensity, uCausticGain, uNormalStrength, uDebug;
uniform mat4 uInvViewProj;
uniform vec2 uDepthRes;
uniform vec4 uRipples[ ${RIPPLE_SLOTS} ];

varying vec3 vWorld;
varying vec4 vReflectUV;
varying float vCaustic;
varying float vTint;
varying float vViewZ;

// 深度采样对齐折射 RT 像素中心（RT 是 0.6× 分辨率，不 snap 会在剪影边缘取错深度）
vec2 snapUV( vec2 uv ) { return ( floor( uv * uDepthRes ) + 0.5 ) / uDepthRes; }

// 由窗口深度反算世界坐标
vec3 worldFromDepth( vec2 uv, float rawDepth ) {
  vec4 ndc = vec4( uv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0 );
  vec4 w = uInvViewProj * ndc;
  return w.xyz / w.w;
}

vec3 rippleNormal( vec2 p, float scale, vec2 vel ) {
  return texture2D( tRipple, p / scale + vel * uTime ).xyz * 2.0 - 1.0;
}

void main() {
  vec2 screenUV = gl_FragCoord.xy / uResolution;

  // ---------- 水面法线：两层滚动波 + 玩家涟漪 ----------
  vec3 n1 = rippleNormal( vWorld.xz, 3.1, vec2( 0.0075, 0.0048 ) );
  vec3 n2 = rippleNormal( vWorld.xz, 0.95, vec2( -0.0115, 0.0088 ) );
  // 切线空间(x,y,z) → 水平面世界空间(x,z,y)
  vec3 N = normalize( vec3(
    ( n1.x * 0.6 + n2.x * 0.4 ) * uNormalStrength,
    1.0,
    ( n1.y * 0.6 + n2.y * 0.4 ) * uNormalStrength
  ) );

  for ( int i = 0; i < ${RIPPLE_SLOTS}; i ++ ) {
    vec4 r = uRipples[ i ];
    if ( r.w <= 0.0 ) continue;
    float age = uTime - r.z;
    if ( age < 0.0 || age > 3.2 ) continue;
    vec2 d2 = vWorld.xz - r.xy;
    float d = length( d2 ) + 1e-4;
    float front = age * 2.3 + 0.06;
    if ( d > front ) continue;
    float amp = r.w * exp( -age * 1.7 ) * exp( -d * 0.7 ) * 0.5;
    float phase = d * 11.0 - age * 8.5;
    N.xz += normalize( d2 ) * cos( phase ) * amp;
  }
  N = normalize( N );
  if ( uSubmerged > 0.5 ) N = -N;

  vec3 V = normalize( uCamPos - vWorld );
  float NoV = clamp( dot( N, V ), 0.0, 1.0 );

  // ---------- 折射 / 吸收 / caustics ----------
  float rawD = texture2D( tRefractDepth, snapUV( screenUV ) ).x;
  vec3 bottom = worldFromDepth( screenUV, rawD );
  float valid = step( rawD, 0.99995 );
  // 命中点必须在水面之下才算"水中行程"
  float underMask = ( 1.0 - smoothstep( -0.04, 0.04, bottom.y ) ) * valid;
  float path = length( bottom - vWorld ) * underMask;

  // 扰动折射 UV（幅度随水深增加、随距离衰减，浅水几乎不扭）
  float distCam = length( uCamPos - vWorld );
  vec2 distort = N.xz * ( 0.055 * min( path, 3.5 ) ) / max( 1.0, distCam * 0.22 );
  vec2 ruv = clamp( screenUV + distort, vec2( 0.0015 ), vec2( 0.9985 ) );
  // 折射掩膜：扰动后若采到水面之上的物体，退回未扰动 UV（防止水上墙色渗进水里）
  vec3 b2 = worldFromDepth( ruv, texture2D( tRefractDepth, snapUV( ruv ) ).x );
  if ( b2.y > 0.06 && uSubmerged < 0.5 ) ruv = screenUV;

  vec3 refr = texture2D( tRefract, ruv ).rgb;

  if ( uSubmerged < 0.5 ) {
    vec3 absorb = exp( -uAbsorb * path );
    refr *= absorb;
    // caustics：两层不同速度/尺度相乘 → 会游动的丝网光斑
    vec2 cuv = bottom.xz;
    float c1 = texture2D( tCaustic, cuv * 0.33 + vec2( 0.011, -0.008 ) * uTime ).r;
    float c2 = texture2D( tCaustic, cuv * 0.21 + vec2( -0.009, 0.012 ) * uTime ).r;
    float caus = c1 * c2 * 2.6;
    float depthFade = smoothstep( 0.02, 0.35, path ) * exp( -path * 0.22 );
    refr += uSunColor * caus * uCausticGain * vCaustic * depthFade * absorb;
  }

  // ---------- 反射 ----------
  vec2 refUV = vReflectUV.xy / max( vReflectUV.w, 1e-4 );
  refUV += N.xz * 0.028;
  vec3 refl = texture2D( tReflect, clamp( refUV, vec2( 0.002 ), vec2( 0.998 ) ) ).rgb * uSkyTint * vTint;   // vTint：露台水面的反射单独压暗，防眩光

  // ---------- Fresnel（水下走全内反射曲线） ----------
  float F;
  if ( uSubmerged > 0.5 ) {
    float sinT = sqrt( max( 0.0, 1.0 - NoV * NoV ) );
    float tir = smoothstep( 0.70, 0.775, sinT );          // 临界角 ~48.6°
    F = mix( 0.02 + 0.98 * pow( 1.0 - NoV, 5.0 ), 1.0, tir );
    refl = mix( uFogColor * 1.15, refl * 0.55, 0.4 );      // 水下侧的"镜面"近似
  } else {
    F = 0.02 + 0.98 * pow( 1.0 - NoV, 5.0 );
  }

  vec3 col = mix( refr, refl, clamp( F, 0.0, 1.0 ) );

  // ---------- 太阳镜面高光 ----------
  if ( uSubmerged < 0.5 ) {
    vec3 H = normalize( uSunDir + V );
    float spec = min( pow( max( dot( N, H ), 0.0 ), 680.0 ) * 3.2, 2.2 );
    col += uSunColor * spec;
  }

  // ---------- 分量调试（?wdebug=N，仅用于验证各项是否真的在工作） ----------
  if ( uDebug > 0.5 ) {
    if ( uDebug < 1.5 )      col = refl;                                  // 1 = 只看反射
    else if ( uDebug < 2.5 ) col = texture2D( tRefract, screenUV ).rgb;   // 2 = 只看折射(无吸收)
    else if ( uDebug < 3.5 ) col = vec3( clamp( path / 4.0, 0.0, 1.0 ) ); // 3 = 水中行程(白=深)
    else if ( uDebug < 4.5 ) {                                            // 4 = 只看 caustics
      vec2 cuv = bottom.xz;
      float c1 = texture2D( tCaustic, cuv * 0.33 + vec2( 0.011, -0.008 ) * uTime ).r;
      float c2 = texture2D( tCaustic, cuv * 0.21 + vec2( -0.009, 0.012 ) * uTime ).r;
      col = vec3( c1 * c2 * 2.6 * vCaustic );
    } else                   col = N * 0.5 + 0.5;                         // 5 = 水面法线
    gl_FragColor = vec4( col, 1.0 );
    return;
  }

  // ---------- 雾（ShaderMaterial 不吃 scene.fog，手动对齐 FogExp2） ----------
  float f = 1.0 - exp( -pow( vViewZ * uFogDensity, 2.0 ) );   // 与场景 FogExp2 同度量（-mvPosition.z）
  col = mix( col, uFogColor, clamp( f, 0.0, 1.0 ) );

  gl_FragColor = vec4( col, 1.0 );
}
`;

export class WaterSystem {
  constructor(renderer, level, opts = {}) {
    this.reflectScale = 0.5;
    this.refractScale = 0.6;
    this.submerged = 0;                 // 0..1 平滑量（带滞回，由 update 驱动）
    this._rippleIdx = 0;
    this._time = 0;

    const size = renderer.getSize(new THREE.Vector2());
    this.rtReflect = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 0 });
    this.rtReflect.texture.minFilter = THREE.LinearFilter;
    this.rtReflect.texture.magFilter = THREE.LinearFilter;

    const depth = new THREE.DepthTexture(2, 2, THREE.FloatType);
    depth.format = THREE.DepthFormat;
    this.rtRefract = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType, samples: 0, depthTexture: depth, depthBuffer: true,
    });

    this.ripple = createRippleNormal(7);
    this.caustic = createCausticTexture();

    this.uniforms = {
      tReflect: { value: this.rtReflect.texture },
      tRefract: { value: this.rtRefract.texture },
      tRefractDepth: { value: depth },
      tRipple: { value: this.ripple },
      tCaustic: { value: this.caustic },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0.7, 0.67, 0.25) },
      uSunColor: { value: new THREE.Color(1.0, 0.96, 0.88) },
      uAbsorb: { value: new THREE.Vector3(0.42, 0.09, 0.055) },
      uFogColor: { value: new THREE.Color(0.72, 0.79, 0.83) },
      uSkyTint: { value: new THREE.Color(1, 1, 1) },
      uFogDensity: { value: 0.006 },
      uTime: { value: 0 },
      uSubmerged: { value: 0 },
      uCausticGain: { value: opts.causticGain ?? 0.45 },
      uNormalStrength: { value: 0.42 },   // 泳池水面很静：法线扰动越小，反射越清晰、越"美好"
      uDebug: { value: 0 },
      uTextureMatrix: { value: new THREE.Matrix4() },
      uInvViewProj: { value: new THREE.Matrix4() },
      uDepthRes: { value: new THREE.Vector2(1, 1) },
      uRipples: { value: Array.from({ length: RIPPLE_SLOTS }, () => new THREE.Vector4(0, 0, -99, 0)) },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });
    this.material.name = 'water';

    // 每个水域一片网格（利于视锥剔除）；caustics 强度按分区烘进顶点属性
    const CAUSTIC_BY_ZONE = {
      atrium: 1.0, colonnade: 0.85, terrace: 1.0, stairwell: 0.4, tunnel: 0.12, deepwell: 0.55,
    };
    this.group = new THREE.Group();
    this.group.name = 'water';
    for (const a of level.waterAreas) {
      const w = a.maxX - a.minX, d = a.maxZ - a.minZ;
      const geo = new THREE.PlaneGeometry(w, d, 1, 1);
      geo.rotateX(-Math.PI / 2);
      geo.translate((a.minX + a.maxX) / 2, 0, (a.minZ + a.maxZ) / 2);
      const c = CAUSTIC_BY_ZONE[a.zone] ?? 0.5;
      geo.setAttribute('aCaustic', new THREE.Float32BufferAttribute(new Float32Array(4).fill(c), 1));
      const tint = a.zone === 'terrace' ? 0.78 : 1.0;
      geo.setAttribute('aTint', new THREE.Float32BufferAttribute(new Float32Array(4).fill(tint), 1));
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.name = 'water_' + a.zone;
      mesh.frustumCulled = true;
      this.group.add(mesh);
    }

    // 反射/折射 pass 期间必须隐藏的对象：任何**采样这两张 RT** 的东西
    // （否则形成 framebuffer feedback loop，WebGL 报 GL_INVALID_OPERATION 并丢帧）
    this.hideDuringRT = [];

    // 反射相机与斜投影裁剪所需的临时量（全部复用，避免每帧分配）
    this._rc = new THREE.PerspectiveCamera();
    this._tmp = {
      normal: new THREE.Vector3(), view: new THREE.Vector3(), target: new THREE.Vector3(),
      look: new THREE.Vector3(), rot: new THREE.Matrix4(), plane: new THREE.Plane(),
      clip: new THREE.Vector4(), q: new THREE.Vector4(), pos: new THREE.Vector3(),
      vp: new THREE.Matrix4(), origin: new THREE.Vector3(), planePt: new THREE.Vector3(),
    };
    this.setSize(size.x, size.y);
  }

  setSize(w, h) {
    const rw = Math.max(2, Math.floor(w * this.reflectScale));
    const rh = Math.max(2, Math.floor(h * this.reflectScale));
    this.rtReflect.setSize(rw, rh);
    const fw = Math.max(2, Math.floor(w * this.refractScale));
    const fh = Math.max(2, Math.floor(h * this.refractScale));
    this.rtRefract.setSize(fw, fh);
    // 折射目标是低分辨率的，屏幕 UV 用比例即可（gl_FragCoord/实际画布尺寸）
    this.uniforms.uResolution.value.set(w, h);
    this.uniforms.uDepthRes.value.set(this.rtRefract.width, this.rtRefract.height);
  }

  addRipple(x, z, strength = 1) {
    const i = this._rippleIdx % RIPPLE_SLOTS;
    this._rippleIdx++;
    this.uniforms.uRipples.value[i].set(x, z, this._time, strength);
  }

  /** 每帧更新。sub 是**已平滑**的水下程度(0..1)，由 main.js 统一维护，单一真相源 */
  update(dt, camera, sub, fog) {
    this._time += dt;
    this.uniforms.uTime.value = this._time;
    this.uniforms.uCamPos.value.copy(camera.position);
    this.submerged = sub;
    // 水面着色分支按 0.5 切换（相机过水线的抖动已由 main.js 的平滑 + 死区吸收）
    this.uniforms.uSubmerged.value = sub > 0.5 ? 1 : 0;
    if (fog) {
      this.uniforms.uFogColor.value.copy(fog.color);
      this.uniforms.uFogDensity.value = fog.density;
    }
  }

  /** 反射 + 折射两次离屏渲染（必须在主渲染之前调用） */
  renderTargets(renderer, scene, camera) {
    camera.updateMatrixWorld();   // 审查②-1：不更新会用上一帧的相机变换，反射随转身滑移
    const t = this._tmp;
    const below = this.uniforms.uSubmerged.value > 0.5;
    const rc = this._rc;

    // --- 镜像相机（照 three/addons/objects/Reflector.js 的做法）---
    t.normal.set(0, below ? -1 : 1, 0);
    const planePoint = t.planePt.set(camera.position.x, 0, camera.position.z);

    t.view.subVectors(planePoint, camera.position);
    t.view.reflect(t.normal).negate().add(planePoint);

    t.rot.extractRotation(camera.matrixWorld);
    t.look.set(0, 0, -1).applyMatrix4(t.rot).add(camera.position);
    t.target.subVectors(planePoint, t.look);
    t.target.reflect(t.normal).negate().add(planePoint);

    rc.position.copy(t.view);
    rc.up.set(0, 1, 0).applyMatrix4(t.rot).reflect(t.normal);
    rc.lookAt(t.target);
    rc.near = camera.near; rc.far = camera.far;
    rc.fov = camera.fov; rc.aspect = camera.aspect;
    rc.updateMatrixWorld();
    rc.projectionMatrix.copy(camera.projectionMatrix);

    // 投影贴图矩阵（世界坐标 → 反射图 UV）
    this.uniforms.uTextureMatrix.value.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0
    ).multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);

    // 斜近平面裁剪：把水面当近平面，剔除水面另一侧的一切（替代全局 clippingPlanes）
    t.plane.setFromNormalAndCoplanarPoint(t.normal, t.origin.set(0, 0, 0));
    t.plane.applyMatrix4(rc.matrixWorldInverse);
    t.clip.set(t.plane.normal.x, t.plane.normal.y, t.plane.normal.z, t.plane.constant);
    const pm = rc.projectionMatrix;
    t.q.x = (Math.sign(t.clip.x) + pm.elements[8]) / pm.elements[0];
    t.q.y = (Math.sign(t.clip.y) + pm.elements[9]) / pm.elements[5];
    t.q.z = -1.0;
    t.q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    t.clip.multiplyScalar(2.0 / t.clip.dot(t.q));
    pm.elements[2] = t.clip.x;
    pm.elements[6] = t.clip.y;
    pm.elements[10] = t.clip.z + 1.0 - 0.003;   // clipBias
    pm.elements[14] = t.clip.w;

    // --- Pass A：反射（隐藏水面自身 + 所有采样这些 RT 的对象）---
    this.group.visible = false;
    const hidden = [];
    for (const o of this.hideDuringRT) {
      if (o.visible) { o.visible = false; hidden.push(o); }
    }
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rtReflect);
    renderer.clear();
    renderer.render(scene, rc);

    // --- Pass B：折射（同一相机，水面仍隐藏，附带深度）---
    renderer.setRenderTarget(this.rtRefract);
    renderer.clear();
    renderer.render(scene, camera);
    this.group.visible = true;
    for (const o of hidden) o.visible = true;
    renderer.setRenderTarget(prevTarget);

    // 主相机的逆 viewProj（供水面着色器反算池底世界坐标）
    t.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.uniforms.uInvViewProj.value.copy(t.vp).invert();
  }

  dispose() {
    this.rtReflect.dispose();
    this.rtRefract.dispose();
    this.material.dispose();
    this.ripple.dispose();
    this.caustic.dispose();
    this.group.traverse(o => o.geometry?.dispose());
  }
}
