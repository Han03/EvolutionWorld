/**
 * 渲染器：Three.js 场景 + 相机 + 光照 + 全屏 SDF 体积地形
 */
import * as THREE from 'three';
import { TERRAIN_VERT, TERRAIN_FRAG } from './glsl.js';

export function createRenderer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // 让实体球体随距离淡出，与地形距离雾保持一致
  scene.fog = new THREE.FogExp2(0x9ed5f2, 0.0016);

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 3000);
  camera.position.set(0, 30, 40);

  // 光照（实体球体）
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.position.set(60, 90, 40);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x3d5a3d, 0.9);
  scene.add(hemi);

  // 全屏 SDF 体积地形（含天空）
  const terrainUniforms = {
    uCamPos: { value: new THREE.Vector3() },
    uRes: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    uTime: { value: 0 },
    uProj: { value: new THREE.Matrix4() },
    uInvProj: { value: new THREE.Matrix4() },
    uInvView: { value: new THREE.Matrix4() },
  };
  const terrainMat = new THREE.ShaderMaterial({
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    uniforms: terrainUniforms,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.LessEqualDepth,
  });
  const terrainMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), terrainMat);
  terrainMesh.frustumCulled = false;
  terrainMesh.renderOrder = 1;
  scene.add(terrainMesh);

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    terrainUniforms.uRes.value.set(w, h);
  }
  window.addEventListener('resize', resize);

  /** 在渲染前更新地形着色器统一变量 */
  function updateTerrainUniforms(time) {
    terrainUniforms.uCamPos.value.copy(camera.position);
    terrainUniforms.uTime.value = time;
    terrainUniforms.uProj.value.copy(camera.projectionMatrix);
    terrainUniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    terrainUniforms.uInvView.value.copy(camera.matrixWorldInverse);
  }

  return { renderer, scene, camera, updateTerrainUniforms, resize };
}
