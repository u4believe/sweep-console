/**
 * The hero's iridescent glass blob and arc — v4's centrepiece, where the old
 * design had the animated rail.
 *
 * Ported from the design's holo-scene.js custom element. Two deliberate
 * changes:
 *
 * THREE IS BUNDLED, NOT FETCHED. The original does
 *   await import('https://esm.sh/three@0.160.0')
 * at runtime. A hero that renders nothing when a third-party CDN is slow or
 * blocked is a hero that sometimes does not exist, and a script from another
 * origin executing on ours is a supply-chain surface for a decoration. So
 * three is a dependency, imported lazily inside the effect: it stays out of
 * the entry bundle and off the critical path, and it cannot fail because
 * someone else's server is down.
 *
 * THE FALLBACK IS CSS. With no WebGL — old hardware, a blocked context, a
 * headless browser — the original paints a radial/conic gradient blob, and so
 * does this. The hero keeps a subject either way.
 *
 * Under prefers-reduced-motion the scene renders a single frame and stops,
 * matching the original's `still` branch: the object is there, it just does
 * not move or track the pointer.
 */
import { useEffect, useRef } from "react";

const FALLBACK_BG =
  "radial-gradient(circle at 30% 30%,#fff 0,#b9c6ff 12%,#6b5cff 38%,#2a1fa8 70%,transparent 72%)," +
  "conic-gradient(from 120deg,#ff7be5,#6b5cff,#40e0ff,#ff7be5)";

export function HoloScene({ className }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let raf = 0;
    let ro: ResizeObserver | undefined;
    let onMove: ((e: PointerEvent) => void) | undefined;
    let disposed = false;
    let renderer: import("three").WebGLRenderer | undefined;

    const fallback = () => {
      if (!el || el.querySelector("[data-holo-fallback]")) return;
      const b = document.createElement("div");
      b.setAttribute("data-holo-fallback", "");
      b.style.cssText =
        "position:absolute;left:30%;top:10%;width:46%;aspect-ratio:1;border-radius:50%;" +
        `filter:blur(2px);background:${FALLBACK_BG};`;
      el.appendChild(b);
    };

    (async () => {
      try {
        const THREE = await import("three");
        const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");
        if (disposed) return;

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.15;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.setClearColor(0x000000, 0);
        const cv = renderer.domElement;
        cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
        el.appendChild(cv);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
        camera.position.set(0, 0, 11);
        const pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

        const mk = (color: number, sheen: number) =>
          new THREE.MeshPhysicalMaterial({
            color,
            metalness: 0.3,
            roughness: 0.14,
            clearcoat: 1,
            clearcoatRoughness: 0.06,
            iridescence: 1,
            iridescenceIOR: 1.7,
            iridescenceThicknessRange: [120, 900],
            sheen: 1,
            sheenRoughness: 0.35,
            sheenColor: new THREE.Color(sheen),
            envMapIntensity: 1.7,
          });

        // An icosahedron pushed around by three sine fields: the hand-blown
        // look comes from displacing each vertex along its own normal.
        const geo = new THREE.IcosahedronGeometry(1.35, 64);
        const p = geo.attributes.position as import("three").BufferAttribute;
        const n = new THREE.Vector3();
        for (let i = 0; i < p.count; i++) {
          n.fromBufferAttribute(p, i).normalize();
          const d =
            0.16 * Math.sin(5 * n.x + 1.3) * Math.sin(6 * n.y + 0.4) +
            0.12 * Math.sin(7 * n.z + 2.1) * Math.cos(4 * n.x) +
            0.06 * Math.sin(11 * n.y + 3 * n.z);
          p.setXYZ(i, n.x * (1 + d) * 1.35, n.y * (1 + d) * 1.35, n.z * (1 + d) * 1.35);
        }
        geo.computeVertexNormals();
        const blob = new THREE.Mesh(geo, mk(0x5a4dff, 0xff7be5));
        blob.position.set(0.9, 1.35, 0);
        scene.add(blob);

        const arc = new THREE.Mesh(
          new THREE.TorusGeometry(3.1, 0.62, 96, 260, Math.PI * 1.25),
          mk(0x3d4bff, 0x40e0ff)
        );
        arc.position.set(0.6, -1.9, -1.2);
        arc.rotation.set(-1.05, 0.25, 2.55);
        scene.add(arc);

        const light = (c: number, intensity: number, x: number, y: number, z: number) => {
          const l = new THREE.PointLight(c, intensity, 0, 2);
          l.position.set(x, y, z);
          scene.add(l);
        };
        light(0xff4fd8, 60, -4, 3, 4);
        light(0x40e0ff, 55, 4, -2, 4);
        light(0x6b5cff, 40, 0, 5, 2);
        light(0xffd36b, 20, 3, 4, -2);
        scene.add(new THREE.AmbientLight(0x4b3bff, 0.25));

        const resize = () => {
          const w = el.clientWidth || 1;
          const h = el.clientHeight || 1;
          renderer!.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        };
        ro = new ResizeObserver(resize);
        ro.observe(el);
        resize();

        let mx = 0;
        let my = 0;
        onMove = (e: PointerEvent) => {
          mx = e.clientX / window.innerWidth - 0.5;
          my = e.clientY / window.innerHeight - 0.5;
        };
        window.addEventListener("pointermove", onMove, { passive: true });

        const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        const t0 = performance.now();
        const tick = () => {
          const t = (performance.now() - t0) / 1000;
          if (!still) {
            blob.rotation.y = t * 0.25;
            blob.rotation.x = Math.sin(t * 0.4) * 0.3;
            blob.position.y = 1.35 + Math.sin(t * 0.8) * 0.12;
            arc.rotation.z = 2.55 + Math.sin(t * 0.3) * 0.08;
            scene.rotation.y += (mx * 0.35 - scene.rotation.y) * 0.04;
            scene.rotation.x += (my * 0.2 - scene.rotation.x) * 0.04;
          }
          renderer!.render(scene, camera);
          if (still) return; // one frame is the whole animation
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        console.warn("holo-scene fallback", err);
        fallback();
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      if (onMove) window.removeEventListener("pointermove", onMove);
      if (renderer) {
        renderer.dispose();
        renderer.domElement.remove();
      }
    };
  }, []);

  return <div ref={host} className={className} style={{ position: "relative", width: "100%", height: "100%" }} />;
}
