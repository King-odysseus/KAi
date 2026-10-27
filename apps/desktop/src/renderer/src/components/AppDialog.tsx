import { AlertTriangle, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { UiButton } from './UiButton';
import { Checkbox, Modal, Textarea } from 'flowbite-react';
import { UiTextInput } from './UiTextInput';

export interface PromptDialogOptions {
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  multiline?: boolean;
  rows?: number;
  validate?: (value: string) => string | null;
}

export interface ConfirmDialogOptions {
  title: string;
  detail: string;
  confirmLabel?: string;
  destructive?: boolean;
}

export interface MessageDialogOptions {
  title: string;
  detail: string;
  confirmLabel?: string;
}

/** A confirmation with one checkbox, for a smaller decision that belongs with the main one. */
export interface OptionDialogOptions {
  title: string;
  detail: string;
  confirmLabel?: string;
  destructive?: boolean;
  checkboxLabel: string;
  checkboxChecked?: boolean;
}

export interface OptionDialogResult {
  confirmed: boolean;
  checked: boolean;
}

type DialogRequest =
  | { id: number; kind: 'prompt'; options: PromptDialogOptions; resolve: (value: string | null) => void }
  | { id: number; kind: 'confirm'; options: ConfirmDialogOptions; resolve: (value: boolean) => void }
  | { id: number; kind: 'option'; options: OptionDialogOptions; resolve: (value: OptionDialogResult) => void }
  | { id: number; kind: 'message'; options: MessageDialogOptions; resolve: () => void };

let nextId = 1;
const queue: DialogRequest[] = [];
const listeners = new Set<(request: DialogRequest | null) => void>();

function publish(): void {
  const request = queue[0] ?? null;
  for (const listener of listeners) listener(request);
}

function enqueue<T>(create: (resolve: (value: T) => void) => DialogRequest): Promise<T> {
  return new Promise<T>((resolve) => {
    queue.push(create(resolve as (value: unknown) => void));
    publish();
  });
}

export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  return enqueue<string | null>((resolve) => ({ id: nextId++, kind: 'prompt', options, resolve }));
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return enqueue<boolean>((resolve) => ({ id: nextId++, kind: 'confirm', options, resolve }));
}

export function messageDialog(options: MessageDialogOptions): Promise<void> {
  return enqueue<void>((resolve) => ({ id: nextId++, kind: 'message', options, resolve }));
}

export function optionDialog(options: OptionDialogOptions): Promise<OptionDialogResult> {
  return enqueue<OptionDialogResult>((resolve) => ({ id: nextId++, kind: 'option', options, resolve }));
}

export function DialogHost(): ReactNode {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  useEffect(() => {
    listeners.add(setRequest);
    setRequest(queue[0] ?? null);
    return () => {
      listeners.delete(setRequest);
    };
  }, []);
  if (!request) return null;
  return <Dialog key={request.id} request={request} onFinish={(value) => {
    queue.shift();
    if (request.kind === 'prompt') request.resolve(value as string | null);
    else if (request.kind === 'confirm') request.resolve(Boolean(value));
    else if (request.kind === 'option') request.resolve(value as OptionDialogResult);
    else request.resolve();
    publish();
  }} />;
}

function Dialog({ request, onFinish }: { request: DialogRequest; onFinish: (value: string | null | boolean | OptionDialogResult) => void }): ReactNode {
  const [value, setValue] = useState(request.kind === 'prompt' ? request.options.initialValue ?? '' : '');
  const [checked, setChecked] = useState(request.kind === 'option' ? request.options.checkboxChecked ?? true : false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const cancel = (): void => onFinish(
    request.kind === 'prompt' ? null
      : request.kind === 'option' ? { confirmed: false, checked }
        : request.kind === 'confirm' ? false : true,
  );

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (request.kind === 'option') {
      onFinish({ confirmed: true, checked });
      return;
    }
    if (request.kind !== 'prompt') {
      onFinish(request.kind === 'confirm' ? true : true);
      return;
    }
    const next = value.trim();
    const validation = request.options.validate?.(next) ?? null;
    if (!next) {
      setError(`${request.options.label} is required.`);
      return;
    }
    if (validation) {
      setError(validation);
      return;
    }
    onFinish(next);
  }

  const titleId = `kai-dialog-title-${request.id}`;
  const detailId = `kai-dialog-detail-${request.id}`;
  return (
    <Modal
      show
      size="lg"
      position="center"
      dismissible
      onClose={cancel}
      initialFocus={request.kind === 'prompt' ? inputRef : request.kind === 'message' ? confirmRef : cancelRef}
      aria-labelledby={titleId}
      aria-describedby={detailId}
    >
      <form className="app-dialog" data-kai-dialog="true" onSubmit={submit}>
        <header>
          <span className="app-dialog-icon">{(request.kind === 'confirm' || request.kind === 'option') && request.options.destructive ? <AlertTriangle size={17} /> : <span>K</span>}</span>
          <div><h2 id={titleId}>{request.options.title}</h2><p id={detailId}>{request.kind === 'prompt' ? request.options.label : request.options.detail}</p></div>
          <UiButton type="button" className="icon-button compact" aria-label="Close dialog" onClick={cancel}><X size={14} /></UiButton>
        </header>
        {request.kind === 'prompt' && (
          <label className="app-dialog-field">
            <span>{request.options.label}</span>
            {request.options.multiline ? (
              <Textarea
                ref={inputRef as RefObject<HTMLTextAreaElement>}
                value={value}
                onChange={(event) => { setValue(event.target.value); setError(null); }}
                placeholder={request.options.placeholder}
                rows={request.options.rows ?? 6}
                aria-invalid={Boolean(error)}
              />
            ) : (
              <UiTextInput
                ref={inputRef as RefObject<HTMLInputElement>}
                value={value}
                onChange={(event) => { setValue(event.target.value); setError(null); }}
                placeholder={request.options.placeholder}
                aria-invalid={Boolean(error)}
              />
            )}
          </label>
        )}
        {request.kind === 'option' && (
          <label className="toggle-row">
            <span><strong>{request.options.checkboxLabel}</strong></span>
            <Checkbox checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          </label>
        )}
        {error && <div className="app-dialog-error" role="alert">{error}</div>}
        <footer className={request.kind === 'message' ? 'single-action' : ''}>
          {request.kind !== 'message' && <UiButton ref={cancelRef} type="button" className="secondary-button" onClick={cancel}>Cancel</UiButton>}
          <UiButton ref={confirmRef} type="submit" className={`primary-button ${(request.kind === 'confirm' || request.kind === 'option') && request.options.destructive ? 'destructive-button' : ''}`}>
            {request.options.confirmLabel ?? (request.kind === 'prompt' ? 'OK' : request.kind === 'message' ? 'Close' : 'Confirm')}
          </UiButton>
        </footer>
      </form>
    </Modal>
  );
}
