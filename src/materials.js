// materials.js —— 材质库 + 「连续世界空间 GI 衰减」
//
// 为什么这么做（设计审查 P7 采纳项）：
//   IBL(scene.environment) 是全局无遮挡的，暗房间会被天光照亮而不暗。最初方案是"按房间克隆材质
//   改 envMapIntensity"，但那会在共享墙/门洞处出现硬接缝，还把材质数量乘 3。
//   改进方案：**每套贴图只有一个材质实例**，用 onBeforeCompile 给标准着色器注入一个基于
//   世界坐标的 GI 强度场（若干带羽化的盒体，平滑加权混合），只缩放 IBL 项
//   (iblIrradiance / radiance)，不动直接光。于是明暗是连续过渡的，没有接缝。
//
// 另一处硬约束：墙体是单面几何 → 材质必须 side=DoubleSide 且 shadowSide=DoubleSide，
// 否则单面墙在阴影贴图里被背面剔除 → 完全不投影。
import * as THREE from 'three';
import { createTextureSet } from './textures.js';

const MAX_GI = 14;

// 所有被 patch 的材质共享同一批 uniform 对象 → 更新一次全场生效
export const giUniforms = {
  uGiCount: { value: 0 },
  uGiCenter: { value: Array.from({ length: MAX_GI }, () => new THREE.Vector3()) },
  uGiHalf: { value: Array.from({ length: MAX_GI }, () => new THREE.Vector3(1, 1, 1)) },
  uGiInt: { value: new Float32Array(MAX_GI).fill(1) },
};

export function setGiZones(zones) {
  const n = Math.min(zones.length, MAX_GI);
  giUniforms.uGiCount.value = n;
  for (let i = 0; i < n; i++) {
    const z = zones[i];
    giUniforms.uGiCenter.value[i].copy(z.center);
    giUniforms.uGiHalf.value[i].copy(z.half);
    giUniforms.uGiInt.value[i] = z.intensity;
  }
}

const GI_PARS = /* glsl */`
uniform int uGiCount;
uniform vec3 uGiCenter[${MAX_GI}];
uniform vec3 uGiHalf[${MAX_GI}];
uniform float uGiInt[${MAX_GI}];
varying vec3 vWPos;
// 盒体加权：越靠盒心权重越高，边缘 smoothstep 羽化 → 房间之间连续过渡
float giScaleAt( vec3 p ) {
  float wsum = 0.0;
  float isum = 0.0;
  for ( int i = 0; i < ${MAX_GI}; i ++ ) {
    if ( i >= uGiCount ) break;
    vec3 d = abs( p - uGiCenter[ i ] ) / max( uGiHalf[ i ], vec3( 0.001 ) );
    float m = max( max( d.x, d.y ), d.z );
    float w = 1.0 - smoothstep( 0.45, 1.0, m );
    wsum += w;
    isum += w * uGiInt[ i ];
  }
  return wsum > 1e-4 ? isum / wsum : 1.0;
}
`;

function patchGI(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGiCount = giUniforms.uGiCount;
    shader.uniforms.uGiCenter = giUniforms.uGiCenter;
    shader.uniforms.uGiHalf = giUniforms.uGiHalf;
    shader.uniforms.uGiInt = giUniforms.uGiInt;

    shader.vertexShader = 'varying vec3 vWPos;\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\n  vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;'
    );
    shader.fragmentShader = GI_PARS + shader.fragmentShader.replace(
      '#include <lights_fragment_maps>',
      `#include <lights_fragment_maps>
      {
        // 只缩放"间接光"三项：环境/半球光(irradiance)、IBL 漫反射、IBL 镜面。
        // 直接光(太阳/点光)不缩放 —— 暗房间里的一束阳光本来就该是亮的。
        float giS = giScaleAt( vWPos );
        #if defined( RE_IndirectDiffuse )
          irradiance *= giS;
          iblIrradiance *= giS;
        #endif
        #if defined( RE_IndirectSpecular )
          radiance *= giS;
        #endif
      }`
    );
  };
  material.customProgramCacheKey = () => 'poolrooms-gi';
  return material;
}

// 每套贴图的材质调参（roughness/metalness 基底来自贴图，这里给乘数与法线强度）
const TUNING = {
  mosaic:   { metalness: 0.02, normalScale: 1.00 },
  wallTile: { metalness: 0.02, normalScale: 0.90 },
  deck:     { metalness: 0.00, normalScale: 1.15 },
  deckWet:  { metalness: 0.04, normalScale: 0.95 },
  plaster:  { metalness: 0.00, normalScale: 0.70 },
  blueTrim: { metalness: 0.03, normalScale: 0.85 },
  metal:    { metalness: 0.94, normalScale: 0.70 },
};

export class MaterialLibrary {
  constructor(renderer) {
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this._sets = new Map();
    this._mats = new Map();
  }

  set(name) {
    let s = this._sets.get(name);
    if (!s) {
      s = createTextureSet(name, { anisotropy: this.anisotropy });
      const r = 1 / s.spanMeters;   // UV 单位是米 → repeat = 1/覆盖米数
      for (const t of [s.map, s.normalMap, s.roughnessMap]) {
        if (!t) continue;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(r, r);
        t.anisotropy = this.anisotropy;
        t.needsUpdate = true;
      }
      this._sets.set(name, s);
    }
    return s;
  }

  get(name) {
    let m = this._mats.get(name);
    if (m) return m;
    // 变体语法 name:tint（复用同一套贴图，只调基色）——露台浅水池底需要深一号，防太阳直晒爆白
    const [base, tintHex] = name.split(':');
    const s = this.set(base);
    const tune = TUNING[base] || {};
    m = new THREE.MeshStandardMaterial({
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.roughnessMap,
      roughness: 1.0,
      metalness: tune.metalness ?? 0.0,
      envMapIntensity: 1.0,      // 局部强弱交给 GI 场
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
      dithering: true,
    });
    if (tintHex) m.color.set(Number(tintHex));
    m.normalScale.set(tune.normalScale ?? 1, tune.normalScale ?? 1);
    m.name = name;
    patchGI(m);
    this._mats.set(name, m);
    return m;
  }

  /** 自发光灯具（交给 bloom 发光；不参与 GI patch） */
  emissive(color = 0xfff2dc, intensity = 5) {
    const key = `emissive:${color}:${intensity}`;
    let m = this._mats.get(key);
    if (m) return m;
    m = new THREE.MeshStandardMaterial({
      color: 0x08090a, roughness: 0.45, metalness: 0.0,
      emissive: new THREE.Color(color), emissiveIntensity: intensity,
      side: THREE.FrontSide,
    });
    m.name = key;
    this._mats.set(key, m);
    return m;
  }

  dispose() {
    for (const m of this._mats.values()) m.dispose();
    for (const s of this._sets.values()) {
      s.map?.dispose(); s.normalMap?.dispose(); s.roughnessMap?.dispose();
    }
    this._mats.clear(); this._sets.clear();
  }
}
