// postfx.js —— 后处理链
//
// 顺序依据（设计审查 P2，r185 源码注释为准）：
//   RenderPass → GTAO → Bloom → Grade(线性域调色/水下) → SMAA(必须在线性域) → OutputPass(末位)
// · SMAAPass 源码明确声明运行于 linear-srgb，必须在 OutputPass 之前
// · OutputPass 是唯一做 tone mapping + sRGB 编码的环节，必须是最后一个 pass
//   （其后再放 pass 会被 renderer 二次 tone map + 二次 gamma）
// · GTAO 用**不含水面/光柱/尘埃**的 AO 场景，因为它靠 overrideMaterial 渲染 GBuffer，
//   会把不透明化的水面当遮挡体，导致池底 AO 丢失 + 水面出现假暗角
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const GradeShader = {
  name: 'PoolroomsGrade',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSub: { value: 0 },              // 水下程度 0..1（平滑）
    uGrain: { value: 0.010 },
    uVignette: { value: 0.30 },
    uAberration: { value: 0.0016 },
    uExposure: { value: 1.0 },
    uTint: { value: new THREE.Color(0.42, 0.78, 0.92) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uSub, uGrain, uVignette, uAberration, uExposure;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec2 uv = vUv;
      // 水下：轻微 UV 摇晃（像透过水看东西）
      if ( uSub > 0.001 ) {
        float w = 0.0032 * uSub;
        uv += vec2( sin( uv.y * 21.0 + uTime * 1.35 ), cos( uv.x * 17.0 + uTime * 1.05 ) ) * w;
      }
      vec2 d = uv - 0.5;
      float r2 = dot( d, d );
      // 边缘极轻微色散（镜头感），水下加强
      float ab = uAberration * ( 1.0 + uSub * 2.0 );
      vec3 col;
      col.r = texture2D( tDiffuse, uv + d * ab ).r;
      col.g = texture2D( tDiffuse, uv ).g;
      col.b = texture2D( tDiffuse, uv - d * ab ).b;
      // 水下蓝绿染色
      col = mix( col, col * uTint * 1.15, uSub );
      // 暗角（线性域做，物理上更接近镜头衰减）
      col *= 1.0 - uVignette * r2 * ( 1.0 + uSub * 1.3 );
      col *= uExposure;
      // 极弱胶片颗粒
      float g = fract( sin( dot( vUv * vec2( 1.0, 1.31 ) + uTime * 0.41, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
      col += ( g - 0.5 ) * uGrain;
      gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );
    }
  `,
};

export class PostFX {
  constructor(renderer, scene, camera, aoScene, sceneBounds) {
    const size = renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);     // 内部 RT 默认 HalfFloatType（线性 HDR）
    this.composer.addPass(new RenderPass(scene, camera));

    this.gtao = new GTAOPass(aoScene, camera, size.x, size.y, undefined, {
      radius: 0.55,            // 世界单位：约 55cm 的接触阴影半径
      distanceExponent: 1.4,
      thickness: 1.0,
      scale: 1.0,
      samples: 12,
      screenSpaceRadius: false,
    });
    this.gtao.output = GTAOPass.OUTPUT.Default;        // Default = 与画面相乘
    this.gtao.blendIntensity = 0.85;
    if (sceneBounds) this.gtao.setSceneClipBox(sceneBounds);
    this.composer.addPass(this.gtao);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.28, 0.75, 0.95);
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.smaa = new SMAAPass();                        // 必须在 OutputPass 之前（线性域）
    this.composer.addPass(this.smaa);

    this.output = new OutputPass();                    // AgX tone map + sRGB，末位
    this.composer.addPass(this.output);
  }

  setSize(w, h) { this.composer.setSize(w, h); }

  update(dt, submerged) {
    this.grade.uniforms.uTime.value += dt;
    this.grade.uniforms.uSub.value = submerged;
  }

  setQuality(level) {
    // level: 2 = 全开, 1 = 关 GTAO, 0 = 关 GTAO + 弱 bloom
    this.gtao.enabled = level >= 2;
    this.bloom.strength = level >= 1 ? 0.28 : 0.18;
  }

  render(dt) { this.composer.render(dt); }

  dispose() { this.composer.dispose?.(); }
}
