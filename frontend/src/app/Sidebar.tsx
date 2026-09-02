import { NavLink } from 'react-router-dom';

import { USE_MOCK } from '@/api/config';
import { useAlertCounts } from '@/api/hooks';
import { Badge } from '@/components/ui';
import { NAV_SECTIONS, ROUTES } from './routes';

export function Sidebar() {
  // Unacknowledged alerts drive the nav badge. `new` only — a delivered alert an
  // operator has already looked at should not keep nagging.
  const { data: counts } = useAlertCounts({});
  const openAlerts = counts?.new ?? 0;

  return (
    <aside className="shell__sidebar">
      <div className="brand">
        <span className="brand__mark" aria-hidden="true">
          ANPR
        </span>
        <span className="brand__text">
          <span className="brand__name u-truncate">ANPR Control</span>
          <span className="brand__sub u-truncate">City-wide platform</span>
        </span>
      </div>

      <nav className="nav" aria-label="Main navigation">
        {NAV_SECTIONS.map((section) => {
          const items = ROUTES.filter((route) => route.section === section);
          if (items.length === 0) return null;
          return (
            <div className="nav__section" key={section}>
              <h2 className="nav__heading">{section}</h2>
              <ul>
                {items.map((route) => {
                  const Icon = route.icon;
                  return (
                    <li key={route.path}>
                      <NavLink
                        to={route.path}
                        className={({ isActive }) =>
                          isActive ? 'nav__link is-active' : 'nav__link'
                        }
                        title={route.label}
                      >
                        <span className="nav__icon">
                          <Icon size={17} />
                        </span>
                        <span className="nav__label u-truncate">{route.label}</span>
                        {route.showAlertCount && openAlerts > 0 ? (
                          <span
                            className="nav__count"
                            aria-label={`${openAlerts} unacknowledged alerts`}
                          >
                            {openAlerts > 99 ? '99+' : openAlerts}
                          </span>
                        ) : null}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="sidebar__foot">
        {/* The data source is stated in the chrome, not buried in a tooltip. */}
        <Badge tone={USE_MOCK ? 'violet' : 'ok'} dot>
          {USE_MOCK ? 'Fixture data' : 'Live API'}
        </Badge>
        <span className="u-dim" style={{ fontSize: 'var(--fs-2xs)' }}>
          {USE_MOCK
            ? 'In-browser fixtures. No backend attached.'
            : 'Connected to the ANPR API service.'}
        </span>
      </div>
    </aside>
  );
}
