import { createTheme } from 'flowbite-react';

/** Flowbite owns the colors and control dimensions; KAi's active theme supplies the values. */
export const kaiFlowbiteTheme = createTheme({
  modal: {
    root: {
      base: 'fixed inset-0 z-[120] overflow-y-auto overflow-x-hidden p-4',
      show: { on: 'flex bg-[color-mix(in_srgb,var(--bg-deep)_76%,transparent)] backdrop-blur-sm', off: 'hidden' },
      sizes: { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-xl', '2xl': 'max-w-2xl', '3xl': 'max-w-3xl', '4xl': 'max-w-4xl', '5xl': 'max-w-5xl', '6xl': 'max-w-6xl', '7xl': 'max-w-7xl' },
      positions: { center: 'items-center justify-center', 'top-left': 'items-start justify-start', 'top-center': 'items-start justify-center', 'top-right': 'items-start justify-end', 'center-left': 'items-center justify-start', 'center-right': 'items-center justify-end', 'bottom-left': 'items-end justify-start', 'bottom-center': 'items-end justify-center', 'bottom-right': 'items-end justify-end' },
    },
    content: {
      base: 'relative h-full w-full md:h-auto',
      inner: 'relative flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-lg border border-[color:var(--border)] bg-[var(--bg-panel)] text-[var(--text)] shadow-[0_24px_80px_rgba(0,0,0,0.5)]',
    },
    body: { base: 'flex-1 overflow-auto p-0', popup: 'pt-0' },
    header: {
      base: 'flex items-start justify-between border-b border-[color:var(--border-soft)] p-4',
      popup: 'border-b-0 p-2',
      title: 'text-[var(--text)]',
      close: { base: 'ms-auto inline-flex items-center rounded-md bg-transparent p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]', icon: 'h-4 w-4' },
    },
    footer: { base: 'flex items-center gap-2 border-t border-[color:var(--border-soft)] p-4', popup: 'border-t' },
  },
  dropdown: {
    arrowIcon: 'ml-2 h-4 w-4',
    content: 'space-y-0.5 p-1.5 text-sm',
    inlineWrapper: 'inline-flex items-center',
    floating: {
      animation: 'transition-opacity',
      arrow: { base: 'absolute z-10 h-2 w-2 rotate-45', style: { dark: 'bg-[var(--bg-panel)]', light: 'bg-[var(--bg-panel)]', auto: 'bg-[var(--bg-panel)]' }, placement: '-4px' },
      base: 'z-50 w-max min-w-48 overflow-hidden rounded-md border border-[color:var(--border)] bg-[var(--bg-panel)] text-[var(--text)] shadow-xl focus:outline-none',
      content: 'text-xs text-[var(--text)]',
      divider: 'my-1 h-px bg-[var(--border-soft)]',
      header: 'block px-3 py-2 text-xs font-medium text-[var(--text-muted)]',
      hidden: 'invisible opacity-0',
      item: { container: '', base: 'flex w-full cursor-pointer appearance-none items-center justify-start gap-2 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-xs text-[var(--text-muted)] focus:ring-0 hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus:bg-[var(--bg-hover)] focus:text-[var(--text)] focus:outline-none', icon: 'h-4 w-4 shrink-0' },
      style: { dark: 'border-[color:var(--border)] bg-[var(--bg-panel)] text-[var(--text)]', light: 'border-[color:var(--border)] bg-[var(--bg-panel)] text-[var(--text)]', auto: 'border-[color:var(--border)] bg-[var(--bg-panel)] text-[var(--text)]' },
      target: 'w-fit',
    },
  },
  badge: {
    root: {
      base: 'inline-flex h-fit items-center gap-1.5 whitespace-nowrap font-medium',
      size: { xs: 'rounded-[var(--radius-pill)] px-2 py-0.5 text-[11px]', sm: 'rounded-[var(--radius-pill)] px-2.5 py-1 text-xs' },
      color: {
        gray: 'bg-[var(--bg-hover)] text-[var(--text-muted)]',
        info: 'bg-[var(--accent-soft)] text-[var(--accent)]',
        success: 'bg-[var(--success-soft)] text-[var(--success)]',
        warning: 'bg-[var(--warning-soft)] text-[var(--waiting)]',
        failure: 'bg-[var(--danger-soft)] text-[var(--danger)]',
      },
    },
    icon: { off: '', on: 'rounded-md px-1 py-0.5' },
  },
  button: {
    // Background only, never a ring: a focused/selected button (a dropdown's current option among them) gets a
    // tint, not a border box — the same choice every other active/selected state in the app makes (see
    // .kai-select-option.selected, .learning-tabs button.active, and the dropdown item's own focus style below).
    // Flowbite's default base carries `focus:ring-4` and its colors carry `focus:ring-gray-300` etc.; the theme merge
    // only dedupes within a utility group, so they survive unless cancelled explicitly. That ring is the rounded box
    // that stays on a button after a click.
    base: 'relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-pill)] border text-center font-medium ring-0 focus:ring-0 focus-visible:ring-0 focus:outline-none focus-visible:outline-none focus-visible:bg-[var(--bg-hover)] disabled:pointer-events-none disabled:opacity-50',
    size: { xs: 'min-h-7 px-3.5 text-xs', sm: 'min-h-8 px-4 text-xs', md: 'min-h-9 px-4 text-sm' },
    color: {
      default: 'border-transparent bg-[var(--mint)] text-[var(--bg-deep)] hover:bg-[var(--mint-strong)]',
      alternative: 'border-transparent bg-[var(--bg-hover)] text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--bg-hover)_82%,var(--text))]',
      gray: 'border-transparent bg-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]',
      red: 'border-transparent bg-[var(--bg-hover)] text-[var(--red)] hover:bg-[color-mix(in_srgb,var(--red)_14%,var(--bg-hover))]',
    },
  },
  textInput: {
    base: 'flex min-w-0',
    field: { input: {
      base: 'block w-full min-w-0 rounded-[10px] border focus:outline-none focus:ring-1 disabled:cursor-not-allowed disabled:opacity-50',
      sizes: { md: 'px-2.5 py-1.5 text-sm' },
      colors: { gray: 'border-[color:var(--border)] bg-[var(--bg-input)] text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[color:var(--mint)] focus:ring-[color:var(--mint)]' },
    } },
  },
  select: {
    base: 'contents',
    field: { base: 'contents', select: {
      base: 'block w-full min-w-0 rounded-[10px] border px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 disabled:cursor-not-allowed disabled:opacity-50',
      colors: { gray: 'border-[color:var(--border)] bg-[var(--bg-input)] text-[var(--text)] focus:border-[color:var(--mint)] focus:ring-[color:var(--mint)]' },
    } },
  },
  textarea: {
    base: 'block w-full rounded-[10px] border p-2.5 text-sm focus:outline-none focus:ring-1 disabled:cursor-not-allowed disabled:opacity-50',
    colors: { gray: 'border-[color:var(--border)] bg-[var(--bg-input)] text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[color:var(--mint)] focus:ring-[color:var(--mint)]' },
  },
  // Flowbite's own checkbox/radio `base` is literal `border-gray-300 bg-gray-100` — fine on a white page, a glaring
  // light box on this dark one. Only `color` was themed before, which recolors the checked mark but leaves the box
  // itself unthemed, which is what made every checkbox in the app look unstyled rather than merely unchecked.
  checkbox: {
    base: 'h-4 w-4 shrink-0 appearance-none rounded border border-[color:var(--border)] bg-[var(--bg-input)] bg-[length:0.55em_0.55em] bg-center bg-no-repeat checked:border-transparent checked:bg-current checked:bg-check-icon focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50',
    color: { default: 'text-[var(--mint)]' },
  },
  radio: {
    base: 'h-4 w-4 shrink-0 appearance-none rounded-full border border-[color:var(--border)] bg-[var(--bg-input)] checked:border-transparent checked:bg-current focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50',
    color: { default: 'text-[var(--mint)]' },
  },
  card: {
    root: {
      base: 'flex rounded-[var(--radius-card)] border border-[color:var(--border-soft)] bg-[var(--bg-shell)] text-[var(--text)] shadow-none',
      children: 'flex h-full flex-col justify-center gap-2 p-3.5',
      horizontal: { off: 'flex-col', on: 'flex-col md:flex-row' },
      href: 'hover:bg-[var(--bg-hover)]',
    },
    img: { base: '', horizontal: { off: 'rounded-t-lg', on: 'rounded-none' } },
  },
  toggleSwitch: {
    root: {
      base: 'group flex rounded-full focus:outline-none',
      active: { on: 'cursor-pointer', off: 'cursor-not-allowed opacity-50' },
      label: 'ms-2.5 text-start text-sm text-[var(--text-muted)]',
      input: 'sr-only',
    },
    toggle: {
      base: 'relative rounded-full after:absolute after:rounded-full after:border-0 after:bg-[var(--bg-deep)] after:transition-all group-focus-visible:brightness-125',
      checked: {
        on: 'after:translate-x-full rtl:after:-translate-x-full',
        off: 'bg-[var(--border)] after:bg-[var(--text-muted)]',
        color: {
          default: 'bg-[var(--accent)]',
          success: 'bg-[var(--success)]',
          warning: 'bg-[var(--waiting)]',
          failure: 'bg-[var(--danger)]',
        },
      },
      sizes: {
        sm: 'h-4 w-7 min-w-7 after:left-0.5 after:top-0.5 after:h-3 after:w-3 rtl:after:right-0.5',
        md: 'h-5 w-9 min-w-9 after:left-0.5 after:top-0.5 after:h-4 after:w-4 rtl:after:right-0.5',
        lg: 'h-6 w-11 min-w-11 after:left-0.5 after:top-0.5 after:h-5 after:w-5 rtl:after:right-0.5',
      },
    },
  },
  table: {
    root: {
      base: 'w-full text-left text-[12.5px] text-[var(--text-muted)]',
      shadow: 'hidden',
      wrapper: 'relative overflow-x-auto',
    },
    body: {
      base: 'group/body',
      cell: { base: 'px-2 py-2 align-top' },
    },
    head: {
      base: 'group/head text-[11px] font-medium text-[var(--text-dim)]',
      cell: { base: 'border-b border-[color:var(--border-soft)] bg-transparent px-2 py-1.5' },
    },
    row: {
      base: 'group/row border-b border-[color:var(--border-soft)] last:border-b-0',
      hovered: 'hover:bg-[var(--bg-hover)]',
      striped: '',
    },
  },
});
