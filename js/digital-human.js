import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// 基础设置
let mixer;
let digitalHuman;
const clock = new THREE.Clock();
const container = document.getElementById('digital-human-container');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
const light = new THREE.PointLight();
light.position.y = 2.65;
light.position.z = 1.44;
light.intensity = 10.0;
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
container.appendChild(renderer.domElement);

// 加载模型（以GLTF模型为例）
const loader = new GLTFLoader();
loader.load('../model/spartan_armour_mkv_-_halo_reach.glb', function(gltf) {
    digitalHuman = gltf.scene;
    scene.add(digitalHuman);
    scene.add(light);
    camera.position.y = 2.46;
    camera.position.z = 7.93;

    mixer = new THREE.AnimationMixer( gltf.scene );
	mixer.clipAction( gltf.animations[ 0 ] ).play();

    const animate = function() {
        const delta = clock.getDelta();
		mixer.update( delta );
        requestAnimationFrame(animate);
        renderer.render(scene, camera);
    };
    animate();
});

// 处理窗口大小调整
window.addEventListener('resize', function() {
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
});

let isDragging = false;
let startX, startY;

// 监听鼠标按下事件
container.addEventListener('mousedown', (event) => {
    // 记录鼠标的初始位置
    startX = event.clientX;
    startY = event.clientY;
    isDragging = true;

    // 阻止默认行为（如文本选择）
    event.preventDefault();
});

// 监听鼠标移动事件
container.addEventListener('mousemove', (event) => {
    if (isDragging) {
        // 计算鼠标的移动距离
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;

        digitalHuman.rotation.y += deltaX * 0.1

        // 更新初始位置
        startX = event.clientX;
        startY = event.clientY;
    }
});

// 监听鼠标松开事件
container.addEventListener('mouseup', () => {
    isDragging = false;
});