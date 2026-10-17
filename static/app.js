import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const modelList = document.querySelector("#file-list");
const uploadInput = document.querySelector("#model-upload");
const viewportElements = [...document.querySelectorAll(".viewport")];
const gltfLoader = new GLTFLoader();
const slots = viewportElements.map(createSlot);
let models = [];
let refreshInFlight = false;
let toastTimer;

function createSlot(element, index) {
  const canvasHost = element.querySelector(".viewport-canvas");
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
  const scene = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  canvasHost.append(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1.7));
  const keyLight = new THREE.DirectionalLight(0xffffff, 3);
  keyLight.position.set(4, 7, 5);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 0.1;
  keyLight.shadow.camera.far = 100;
  keyLight.shadow.normalBias = 0.02;
  keyLight.shadow.radius = 4;
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.9);
  fillLight.position.set(-5, 2, -4);
  scene.add(fillLight);

  const shadowFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.2 }),
  );
  shadowFloor.name = "shadow-floor";
  shadowFloor.rotation.x = -Math.PI / 2;
  shadowFloor.receiveShadow = true;
  scene.add(shadowFloor);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.55;
  controls.target.set(0, 0, 0);

  const slot = {
    element,
    index,
    canvasHost,
    camera,
    scene,
    renderer,
    keyLight,
    shadowFloor,
    controls,
    select: element.querySelector(".model-select"),
    loadButton: element.querySelector(".load-button"),
    fullscreenButton: element.querySelector(".fullscreen-button"),
    currentLabel: element.querySelector(".current-model"),
    loading: element.querySelector(".viewport-loading"),
    modelName: null,
    pendingName: null,
    version: null,
    requestId: 0,
  };

  slot.select.addEventListener("change", () => {
    slot.pendingName = slot.select.value || null;
    element.classList.toggle("has-pending", Boolean(slot.pendingName));
  });
  slot.loadButton.addEventListener("click", () => {
    const model = models.find((item) => item.name === slot.select.value);
    if (!model) {
      clearSlot(slot);
    } else if (model.previewable) {
      loadModel(slot, model);
    } else {
      showToast("A prévia deste arquivo ainda não está disponível.");
    }
  });
  slot.fullscreenButton.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement === element) await document.exitFullscreen();
      else await element.requestFullscreen();
    } catch (error) {
      showToast("Não foi possível abrir este painel em tela cheia.");
      console.error("Falha ao alternar tela cheia:", error);
    }
  });
  element.querySelector(".reset-button").addEventListener("click", () => {
    const model = models.find((item) => item.name === slot.modelName);
    if (model) loadModel(slot, model);
  });
  element.addEventListener("dragover", (event) => {
    if (event.dataTransfer.types.includes("text/plain")) {
      event.preventDefault();
      element.classList.add("is-drop-target");
    }
  });
  element.addEventListener("dragleave", (event) => {
    if (!element.contains(event.relatedTarget)) element.classList.remove("is-drop-target");
  });
  element.addEventListener("drop", (event) => {
    const name = event.dataTransfer.getData("text/plain");
    if (!name) return;
    event.preventDefault();
    element.classList.remove("is-drop-target");
    const model = models.find((item) => item.name === name);
    if (model) loadModel(slot, model);
  });

  new ResizeObserver(() => resizeSlot(slot)).observe(canvasHost);
  document.addEventListener("fullscreenchange", () => {
    const isFullscreen = document.fullscreenElement === element;
    slot.fullscreenButton.title = isFullscreen ? "Sair da tela cheia" : "Abrir em tela cheia";
    slot.fullscreenButton.setAttribute(
      "aria-label",
      `${isFullscreen ? "Sair da tela cheia do" : "Abrir"} visualizador ${index + 1}${isFullscreen ? "" : " em tela cheia"}`,
    );
    resizeSlot(slot);
  });
  resizeSlot(slot);
  return slot;
}

function resizeSlot(slot) {
  const width = slot.canvasHost.clientWidth;
  const height = slot.canvasHost.clientHeight;
  if (!width || !height) return;
  slot.camera.aspect = width / height;
  slot.camera.updateProjectionMatrix();
  slot.renderer.setSize(width, height, false);
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3500);
}

function disposeObject(object) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      for (const value of Object.values(material ?? {})) {
        if (value?.isTexture) value.dispose();
      }
      material?.dispose();
    }
  });
}

function removeSlotModel(slot) {
  const previous = slot.scene.getObjectByName("active-model");
  if (previous) {
    slot.scene.remove(previous);
    disposeObject(previous);
  }
  slot.element.classList.remove("has-model");
}

function clearSlot(slot) {
  slot.requestId++;
  slot.modelName = null;
  slot.pendingName = null;
  slot.version = null;
  slot.select.value = "";
  slot.element.classList.remove("has-pending");
  slot.currentLabel.textContent = "SEM MODELO";
  slot.loading.hidden = true;
  removeSlotModel(slot);
}

function fitCamera(slot, object) {
  const bounds = new THREE.Box3().setFromObject(object);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  object.position.sub(center);

  const largestDimension = Math.max(size.x, size.y, size.z, 0.1);
  const floorExtent = Math.max(largestDimension * 3, 2);
  slot.shadowFloor.position.y = -size.y / 2 - largestDimension * 0.005;
  slot.shadowFloor.scale.set(floorExtent, floorExtent, 1);
  const shadowCamera = slot.keyLight.shadow.camera;
  shadowCamera.left = -largestDimension * 2;
  shadowCamera.right = largestDimension * 2;
  shadowCamera.top = largestDimension * 2;
  shadowCamera.bottom = -largestDimension * 2;
  shadowCamera.far = largestDimension * 10;
  shadowCamera.updateProjectionMatrix();
  const distance = largestDimension / (2 * Math.tan(THREE.MathUtils.degToRad(slot.camera.fov / 2))) * 1.65;
  slot.camera.position.set(distance * 0.72, distance * 0.5, distance);
  slot.camera.near = Math.max(largestDimension / 1000, 0.001);
  slot.camera.far = largestDimension * 100;
  slot.camera.updateProjectionMatrix();
  slot.controls.target.set(0, 0, 0);
  slot.controls.update();
}

async function loadModel(slot, model) {
  const requestId = ++slot.requestId;
  slot.modelName = model.name;
  slot.pendingName = model.name;
  slot.version = model.version;
  slot.select.value = model.name;
  slot.element.classList.remove("has-pending");
  slot.currentLabel.textContent = model.name.toUpperCase();
  slot.loading.hidden = false;

  try {
    const previewUrl = model.previewUrl ?? `/models/${encodeURIComponent(model.name)}`;
    const previewVersion = model.previewVersion ?? model.version;
    const gltf = await gltfLoader.loadAsync(`${previewUrl}?v=${previewVersion}`);
    if (requestId !== slot.requestId) {
      disposeObject(gltf.scene);
      return;
    }
    removeSlotModel(slot);
    gltf.scene.name = "active-model";
    gltf.scene.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    slot.scene.add(gltf.scene);
    fitCamera(slot, gltf.scene);
    slot.element.classList.add("has-model");
    slot.loading.hidden = true;
  } catch (error) {
    if (requestId !== slot.requestId) return;
    slot.loading.hidden = true;
    slot.modelName = null;
    slot.pendingName = null;
    slot.version = null;
    slot.select.value = "";
    slot.currentLabel.textContent = "ERRO AO CARREGAR";
    showToast(`Não foi possível abrir ${model.name}. Confira se o arquivo GLB está íntegro.`);
    console.error(`Falha ao carregar ${model.name}:`, error);
  }
}

function renderLibrary() {
  document.querySelector("#file-count").textContent = String(models.length).padStart(2, "0");
  document.querySelector("#library-empty").hidden = models.length > 0;
  modelList.replaceChildren();

  for (const model of models) {
    const entry = document.createElement("div");
    entry.className = "file-entry";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-row";
    button.draggable = model.previewable;
    button.setAttribute("aria-label", model.previewable ? `Selecionar ${model.name} para carregar` : `Prévia indisponível para ${model.name}`);
    const glyph = document.createElement("span");
    glyph.className = "file-glyph";
    glyph.textContent = model.format;
    const info = document.createElement("span");
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = model.name;
    const subtitle = document.createElement("span");
    subtitle.className = "file-subtitle";
    subtitle.textContent = model.linked
      ? "GITHUB · ATUALIZAÇÃO AUTOMÁTICA"
      : model.previewable
        ? new Date(model.updated).toLocaleString("pt-BR")
        : `ARQUIVO FONTE · ${new Date(model.updated).toLocaleDateString("pt-BR")}`;
    info.append(name, subtitle);
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatSize(model.size);
    button.append(glyph, info, size);
    button.addEventListener("click", () => model.previewable
      ? assignToEmptySlot(model)
      : showToast("A prévia deste arquivo ainda não está disponível."));
    if (model.previewable) {
      button.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", model.name);
        event.dataTransfer.effectAllowed = "copy";
        button.classList.add("is-dragging");
      });
      button.addEventListener("dragend", () => button.classList.remove("is-dragging"));
    }
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "delete-file-button";
    deleteButton.title = "Excluir arquivo da biblioteca";
    deleteButton.setAttribute("aria-label", `Excluir ${model.name} da biblioteca`);
    deleteButton.textContent = "×";
    deleteButton.addEventListener("click", () => deleteModel(model));
    entry.append(button, deleteButton);
    modelList.append(entry);
  }

  for (const slot of slots) {
    const selectedName = slot.pendingName ?? slot.modelName;
    slot.select.replaceChildren(new Option("Carregar modelo", ""));
    for (const model of models) {
      slot.select.add(new Option(`${model.name} · ${model.format}`, model.name));
    }
    if (models.some((model) => model.name === selectedName)) {
      slot.select.value = selectedName;
      slot.pendingName = selectedName;
    } else {
      slot.pendingName = null;
      slot.element.classList.remove("has-pending");
    }
  }
}

async function deleteModel(model) {
  if (!window.confirm(`Excluir "${model.name}" da biblioteca compartilhada?`)) return;
  try {
    const response = await fetch(`/api/models/${encodeURIComponent(model.name)}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail ?? "Não foi possível excluir o arquivo.");
    await refreshModels();
    showToast(`${model.name} foi removido da biblioteca.`);
  } catch (error) {
    showToast(error.message || "Não foi possível excluir o arquivo.");
  }
}

function assignToEmptySlot(model) {
  if (!model.previewable) {
    showToast("A prévia deste arquivo ainda não está disponível.");
    return;
  }
  const emptySlot = slots.find((slot) => !slot.modelName);
  if (!emptySlot) {
    showToast("Os quatro espaços já estão ocupados. Escolha um painel para substituir o modelo.");
    return;
  }
  emptySlot.select.value = model.name;
  emptySlot.pendingName = model.name;
  emptySlot.element.classList.add("has-pending");
  showToast(`Selecionado no visualizador ${emptySlot.index + 1}. Clique em Carregar.`);
}

async function refreshModels() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const response = await fetch("/api/models", { cache: "no-store" });
    if (!response.ok) throw new Error("Falha ao consultar a biblioteca.");
    const nextModels = await response.json();
    const oldSignature = models.map((model) => `${model.name}:${model.version}`).join("|");
    const newSignature = nextModels.map((model) => `${model.name}:${model.version}`).join("|");
    models = nextModels;
    if (oldSignature !== newSignature) {
      renderLibrary();
      for (const slot of slots) {
        const latestModel = models.find((model) => model.name === slot.modelName && model.previewable);
        if (!latestModel && slot.modelName) {
          clearSlot(slot);
        } else if (latestModel && latestModel.version !== slot.version) {
          loadModel(slot, latestModel);
        }
      }
    }
  } catch (error) {
    console.error("Falha ao atualizar biblioteca:", error);
  } finally {
    refreshInFlight = false;
  }
}

async function uploadFile(file) {
  if (!file) return;
  const extension = file.name.split(".").pop().toLowerCase();
  if (!new Set(["blend", "blend1", "glb"]).has(extension)) {
    showToast("Envie um arquivo .blend, .blend1 ou .glb.");
    return;
  }
  const form = new FormData();
  form.append("file", file);
  showToast("Enviando modelo para a biblioteca compartilhada...");
  try {
    const response = await fetch("/api/models", { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail ?? "Não foi possível enviar o arquivo.");
    await refreshModels();
    const uploadedModel = models.find((model) => model.name === result.name);
    if (uploadedModel?.previewable) assignToEmptySlot(uploadedModel);
    showToast(uploadedModel?.previewable
      ? "Modelo compartilhado com todos os participantes conectados."
      : "Arquivo .blend compartilhado. Exporte também como .glb para visualizar.");
  } catch (error) {
    showToast(error.message || "Não foi possível enviar o modelo.");
  } finally {
    uploadInput.value = "";
  }
}

uploadInput.addEventListener("change", (event) => uploadFile(event.target.files[0]));

const githubDialog = document.querySelector("#github-dialog");
document.querySelector("#github-open").addEventListener("click", () => githubDialog.showModal());
document.querySelector("#github-close").addEventListener("click", () => githubDialog.close());
document.querySelector("#github-cancel").addEventListener("click", () => githubDialog.close());
document.querySelector("#github-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const urlInput = document.querySelector("#github-url");
  const submitButton = event.currentTarget.querySelector("[type=submit]");
  submitButton.disabled = true;
  showToast("Importando arquivo do GitHub...");
  try {
    const response = await fetch("/api/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlInput.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail ?? "Não foi possível importar o arquivo.");
    await refreshModels();
    const importedModel = models.find((model) => model.name === result.name);
    if (importedModel?.previewable) assignToEmptySlot(importedModel);
    githubDialog.close();
    urlInput.value = "";
    showToast(importedModel?.previewable
      ? "Prévia carregada. O link será verificado automaticamente."
      : "Arquivo importado, mas não foi possível gerar a prévia 3D.");
  } catch (error) {
    showToast(error.message || "Não foi possível importar o arquivo do GitHub.");
  } finally {
    submitButton.disabled = false;
  }
});

const fileDropOverlay = document.querySelector("#file-drop-overlay");

function isFileDrag(event) {
  return event.dataTransfer && (
    [...event.dataTransfer.types].includes("Files")
    || [...event.dataTransfer.items].some((item) => item.kind === "file")
  );
}

document.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  fileDropOverlay.classList.add("is-visible");
}, true);

document.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
}, true);

document.addEventListener("dragleave", (event) => {
  if (!isFileDrag(event)) return;
  if (event.relatedTarget && document.documentElement.contains(event.relatedTarget)) return;
  fileDropOverlay.classList.remove("is-visible");
}, true);

document.addEventListener("drop", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  fileDropOverlay.classList.remove("is-visible");
  const file = event.dataTransfer.files[0];
  if (file) uploadFile(file);
}, true);

function setConnection(online) {
  const connection = document.querySelector("#connection");
  connection.classList.toggle("is-offline", !online);
  document.querySelector("#connection-label").textContent = online ? "AO VIVO" : "RECONECTANDO";
}

function connectUpdates() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  socket.addEventListener("open", () => setConnection(true));
  socket.addEventListener("message", () => refreshModels());
  socket.addEventListener("close", () => {
    setConnection(false);
    setTimeout(connectUpdates, 1200);
  });
  socket.addEventListener("error", () => socket.close());
}

function animate() {
  requestAnimationFrame(animate);
  for (const slot of slots) {
    slot.controls.update();
    slot.renderer.render(slot.scene, slot.camera);
  }
}

animate();
refreshModels();
connectUpdates();
setInterval(refreshModels, 5000);