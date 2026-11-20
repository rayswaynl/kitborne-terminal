// three.js loads with the first 3D view, so a page without a model skips the download. Importers read the live bindings after load3d() resolves.
export let THREE, GLTFLoader, OrbitControls;
let loading;
export const load3d = () => loading ||= Promise.all([import('three'), import('three/addons/loaders/GLTFLoader.js'), import('three/addons/controls/OrbitControls.js')])
  .then(([three, loader, controls]) => { THREE = three; GLTFLoader = loader.GLTFLoader; OrbitControls = controls.OrbitControls; })
  .catch(error => { loading = null; throw error; });
