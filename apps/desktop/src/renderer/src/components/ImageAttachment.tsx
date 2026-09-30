import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';

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
  return (
    <span className="attachment-chip" title={size ? `${name} (${size})` : name}>
      <img className="attachment-thumb" src={dataUrl} alt="" onLoad={onLoad} />
      <span className="attachment-meta">
        <strong className="truncate">{name}</strong>
        {size && <small>{size}</small>}
      </span>
      <button type="button" aria-label={`Remove ${name}`} onClick={onRemove}><X size={12} /></button>
    </span>
  );
}

/** An image already sent, shown in the conversation. Click it to see it larger. */
export function ImageCard({ name, dataUrl }: { name: string; dataUrl: string }): ReactNode {
  const { size, onLoad } = useImageSize();
  const [expanded, setExpanded] = useState(false);
  return (
    <figure className={`message-image-attachment${expanded ? ' expanded' : ''}`}>
      <button type="button" className="message-image-button" aria-label={expanded ? `Shrink ${name}` : `Enlarge ${name}`} onClick={() => setExpanded((value) => !value)}>
        <img src={dataUrl} alt={name} onLoad={onLoad} />
      </button>
      <figcaption><strong className="truncate">{name}</strong>{size && <small>{size}</small>}</figcaption>
    </figure>
  );
}
