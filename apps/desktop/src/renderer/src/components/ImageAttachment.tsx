import { X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { UiButton } from './UiButton';

function useImageSize(): { size: string | null; onLoad: (event: { currentTarget: HTMLImageElement }) => void } {
  const [size, setSize] = useState<string | null>(null);
  return {
    size,
    onLoad: (event) => {
      const { naturalWidth, naturalHeight } = event.currentTarget;
      if (naturalWidth > 0 && naturalHeight > 0) setSize(`${naturalWidth}×${naturalHeight}`);
    },
  };
}

/** An attached image in the composer: a thumbnail with its name and pixel size, and a way to remove it. */
export function ImageChip({ name, dataUrl, onRemove }: { name: string; dataUrl: string; onRemove: () => void }): ReactNode {
  const { size, onLoad } = useImageSize();
  const [open, setOpen] = useState(false);
  return (
    <span className="attachment-chip kai-pill" title={size ? `${name} (${size})` : name}>
      <button type="button" className="attachment-preview-button" aria-label={`View ${name}`} onClick={() => setOpen(true)}>
        <img className="attachment-thumb" src={dataUrl} alt="" onLoad={onLoad} />
      </button>
      <span className="attachment-meta">
        <strong className="truncate">{name}</strong>
        {size && <small>{size}</small>}
      </span>
      <UiButton type="button" aria-label={`Remove ${name}`} onClick={onRemove}><X size={12} /></UiButton>
      {open && <ImageViewer name={name} dataUrl={dataUrl} onClose={() => setOpen(false)} />}
    </span>
  );
}

/** An image already sent or generated, shown in the conversation. */
export function ImageCard({ name, dataUrl }: { name: string; dataUrl: string }): ReactNode {
  const { size, onLoad } = useImageSize();
  const [open, setOpen] = useState(false);
  return (
    <figure className="message-image-attachment">
      <UiButton type="button" className="message-image-button" aria-label={`View ${name}`} onClick={() => setOpen(true)}>
        <img src={dataUrl} alt={name} onLoad={onLoad} />
      </UiButton>
      <figcaption><strong className="truncate">{name}</strong>{size && <small>{size}</small>}</figcaption>
      {open && <ImageViewer name={name} dataUrl={dataUrl} onClose={() => setOpen(false)} />}
    </figure>
  );
}

/** A full-window view shared by composer attachments, sent images, and generated images. */
export function ImageViewer({ name, dataUrl, onClose }: { name: string; dataUrl: string; onClose: () => void }): ReactNode {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); previousFocus?.focus(); };
  }, [onClose]);
  return createPortal(
    <div className="image-viewer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="image-viewer" role="dialog" aria-modal="true" aria-label={name}>
        <div className="image-viewer-head"><strong>{name}</strong><UiButton ref={closeRef} type="button" aria-label="Close image" onClick={onClose}><X size={18} /></UiButton></div>
        <img src={dataUrl} alt={name} />
      </div>
    </div>, document.body,
  );
}
