/**
 * Small form primitives for the settings page.
 *
 * Written here rather than imported from the harness's UI package: a bundled
 * client may not depend on another package's internal control (it can change
 * without notice, and a throwing component would blank the slot). Each control
 * carries its own class prefix and theme tokens, so it looks like the harness
 * without sharing its implementation.
 *
 * @module dsh-feishu-session-manager/client/Controls
 */

import type { ReactElement, ReactNode } from 'react'

/** One labelled control row. */
export interface RowProps {
  /** Visible label. */
  readonly label: string
  /** Supporting copy under the control. */
  readonly hint?: string
  /** The control itself. */
  readonly children: ReactNode
}

/**
 * Render one row of the settings table.
 * @param props - label, hint and control.
 * @returns the row element.
 */
export function Row({ label, hint, children }: RowProps): ReactElement {
  return (
    <div className="dfsm-row">
      <div className="dfsm-label">{label}</div>
      <div className="dfsm-control">
        {children}
        {hint === undefined ? null : <div className="dfsm-hint">{hint}</div>}
      </div>
    </div>
  )
}

/** One titled group of rows. */
export interface GroupProps {
  readonly title: string
  readonly hint?: string
  readonly children: ReactNode
}

/**
 * Render one titled card.
 * @param props - title, hint and rows.
 * @returns the group element.
 */
export function Group({ title, hint, children }: GroupProps): ReactElement {
  return (
    <section className="dfsm-group">
      <div className="dfsm-group-head">
        <h3 className="dfsm-group-title">{title}</h3>
        {hint === undefined ? null : <p className="dfsm-group-hint">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

/** An on/off switch that keeps native semantics (`role="switch"`). */
export interface ToggleProps {
  readonly checked: boolean
  readonly disabled?: boolean
  readonly label: string
  readonly onChange: (next: boolean) => void
}

/**
 * Render one switch.
 * @param props - state and change handler.
 * @returns the switch element.
 */
export function Toggle({ checked, disabled, label, onChange }: ToggleProps): ReactElement {
  return (
    <div className="dfsm-inline">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="dfsm-switch"
        disabled={disabled === true}
        onClick={() => {
          onChange(!checked)
        }}
      />
    </div>
  )
}

/** A single-line text field. */
export interface TextFieldProps {
  readonly value: string
  readonly label: string
  readonly placeholder?: string
  readonly type?: 'text' | 'password'
  readonly disabled?: boolean
  readonly onChange: (next: string) => void
}

/**
 * Render one text input.
 * @param props - value and change handler.
 * @returns the input element.
 */
export function TextField({ value, label, placeholder, type, disabled, onChange }: TextFieldProps): ReactElement {
  return (
    <input
      className="dfsm-input"
      type={type ?? 'text'}
      aria-label={label}
      value={value}
      placeholder={placeholder ?? ''}
      disabled={disabled === true}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => {
        onChange(event.target.value)
      }}
    />
  )
}

/** A numeric field that never emits a non-finite value. */
export interface NumberFieldProps {
  readonly value: number
  readonly label: string
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly disabled?: boolean
  readonly onChange: (next: number) => void
}

/**
 * Render one number input.
 * @param props - value and change handler.
 * @returns the input element.
 */
export function NumberField({ value, label, min, max, step, disabled, onChange }: NumberFieldProps): ReactElement {
  return (
    <input
      className="dfsm-input"
      type="number"
      aria-label={label}
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      step={step ?? 1}
      disabled={disabled === true}
      onChange={(event) => {
        const parsed = Number(event.target.value)
        if (Number.isFinite(parsed)) onChange(parsed)
      }}
    />
  )
}

/** One selectable option. */
export interface Option {
  readonly value: string
  readonly label: string
}

/** A dropdown. */
export interface SelectFieldProps {
  readonly value: string
  readonly label: string
  readonly options: readonly Option[]
  readonly disabled?: boolean
  readonly onChange: (next: string) => void
}

/**
 * Render one select.
 * @param props - value, options and change handler.
 * @returns the select element.
 */
export function SelectField({ value, label, options, disabled, onChange }: SelectFieldProps): ReactElement {
  const known = options.some((option) => option.value === value)
  return (
    <select
      className="dfsm-select"
      aria-label={label}
      value={value}
      disabled={disabled === true}
      onChange={(event) => {
        onChange(event.target.value)
      }}
    >
      {known || value === '' ? null : <option value={value}>{value}</option>}
      {value === '' && options.every((option) => option.value !== '') ? <option value="">—</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/** A multi-line text field. */
export interface TextAreaFieldProps {
  readonly value: string
  readonly label: string
  readonly rows?: number
  readonly disabled?: boolean
  readonly onChange: (next: string) => void
}

/**
 * Render one textarea.
 * @param props - value and change handler.
 * @returns the textarea element.
 */
export function TextAreaField({ value, label, rows, disabled, onChange }: TextAreaFieldProps): ReactElement {
  return (
    <textarea
      className="dfsm-textarea"
      aria-label={label}
      rows={rows ?? 8}
      value={value}
      spellCheck={false}
      disabled={disabled === true}
      onChange={(event) => {
        onChange(event.target.value)
      }}
    />
  )
}

/** A labelled action button. */
export interface ActionButtonProps {
  readonly label: string
  readonly busyLabel?: string
  readonly busy?: boolean
  readonly primary?: boolean
  readonly disabled?: boolean
  readonly onClick: () => void
}

/**
 * Render one button with its busy state.
 * @param props - label and handler.
 * @returns the button element.
 */
export function ActionButton({ label, busyLabel, busy, primary, disabled, onClick }: ActionButtonProps): ReactElement {
  return (
    <button
      type="button"
      className={primary === true ? 'dfsm-button dfsm-button-primary' : 'dfsm-button'}
      disabled={disabled === true || busy === true}
      onClick={onClick}
    >
      {busy === true ? (busyLabel ?? label) : label}
    </button>
  )
}