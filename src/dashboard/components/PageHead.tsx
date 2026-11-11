import { useEffect, type ReactNode } from 'react'
import { Link } from '../router.tsx'

export interface Crumb {
  href: string
  label: string
}

/** The page's one h1, with its trail of links back, its meta and anything pinned to the end. */
export function PageHead({ title, docTitle, crumbs = [], meta, end }: { title: ReactNode; docTitle: string; crumbs?: Crumb[]; meta?: ReactNode; end?: ReactNode }) {
  useEffect(() => {
    document.title = `${docTitle} · Sherpa`
  }, [docTitle])
  return (
    <header className="page-head">
      {crumbs.length > 0 && (
        <nav aria-label="Breadcrumb">
          <ol className="crumbs">
            {crumbs.map((c) => (
              <li key={c.href}>
                <Link href={c.href}>{c.label}</Link>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="page-head__row">
        <h1 tabIndex={-1}>{title}</h1>
        {meta}
        {end && <div className="page-head__end">{end}</div>}
      </div>
    </header>
  )
}
