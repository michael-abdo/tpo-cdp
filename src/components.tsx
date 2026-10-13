// Small shared pieces: the explicit empty state and the error line every page uses (06 §Empty and error states).

import type { ReactNode } from 'react'

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded border border-dashed border-gray-300 p-3 text-sm text-gray-500">{children}</p>
}

/** Shows the 04 error envelope's message. */
export function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
      {message}
    </p>
  )
}

export function Loading() {
  return <p className="text-sm text-gray-500">Loading…</p>
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 rounded border border-gray-200 p-4">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  )
}

/** A label/value pair inside a definition list. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-sm">
      <dt className="w-28 shrink-0 text-gray-500">{label}</dt>
      <dd className="break-all">{children}</dd>
    </div>
  )
}
