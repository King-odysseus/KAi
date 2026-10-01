import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A small particle orb that shows what KAI is doing in the interview: drifting while it waits for you, swirling
 * while it thinks, and settled once the brief is ready. It is decoration, never the only signal (the thread says
 * the same in words), so it draws one still frame under reduced motion and stops while the window is hidden.
 */

export type OrbState = 'idle' | 'thinking' | 'ready';

interface Particle {
  angle: number;
  radius: number;
  speed: number;
  size: number;
}

const COUNT = 46;

function seed(): Particle[] {
  // A fixed pseudo-random spread keeps the orb the same shape on every render of the page.
  return Array.from({ length: COUNT }, (_value, index) => {
    const unit = Math.sin(index * 12.9898) * 43758.5453;
    const fraction = unit - Math.floor(unit);
    return { angle: (index / COUNT) * Math.PI * 2, radius: 0.35 + fraction * 0.6, speed: 0.4 + fraction * 0.9, size: 0.8 + fraction * 1.4 };
  });
}

function cssColor(element: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

export function AgentOrb({ state, size = 34 }: { state: OrbState; size?: number }): ReactNode {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<OrbState>(state);
  stateRef.current = state;

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return undefined;
    const ratio = window.devicePixelRatio || 1;
    element.width = size * ratio;
    element.height = size * ratio;
    context.scale(ratio, ratio);
    const particles = seed();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let time = 0;

    const draw = (): void => {
      const mint = cssColor(element, '--mint', '#66e3bd');
      const lavender = cssColor(element, '--lavender', '#b9a8ff');
      const mode = stateRef.current;
      const spin = mode === 'thinking' ? 1.6 : mode === 'ready' ? 0.15 : 0.45;
      const pull = mode === 'ready' ? 0.55 : 1;
      context.clearRect(0, 0, size, size);
      const centre = size / 2;
      for (const particle of particles) {
        const angle = particle.angle + time * spin * particle.speed;
        const wobble = mode === 'thinking' ? Math.sin(time * 3 + particle.angle * 3) * 0.12 : Math.sin(time + particle.angle) * 0.04;
        const distance = (particle.radius * pull + wobble) * (centre - 3);
        context.beginPath();
        context.fillStyle = particle.speed > 0.9 ? lavender : mint;
        context.globalAlpha = 0.45 + particle.radius * 0.5;
        context.arc(centre + Math.cos(angle) * distance, centre + Math.sin(angle) * distance, particle.size, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const tick = (): void => {
      if (!document.hidden) {
        time += 0.016;
        draw();
      }
      frame = window.requestAnimationFrame(tick);
    };
    draw();
    if (!reduced) frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [size]);

  return <canvas ref={canvas} className={`agent-orb ${state}`} style={{ width: size, height: size }} aria-hidden="true" />;
}
