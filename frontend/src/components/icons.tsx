/**
 * Inline SVG icons. Hand-rolled rather than pulled from an icon package: the set
 * is small, and this keeps the bundle free of a dependency that would only be
 * used a dozen times.
 *
 * All icons are `aria-hidden` and inherit `currentColor`, so they are decoration —
 * every control that uses one still needs its own accessible label.
 */

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const MapIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
    <path d="M9 4v14M15 6v14" />
  </Icon>
);

export const RouteIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="6" cy="19" r="2.5" />
    <circle cx="18" cy="5" r="2.5" />
    <path d="M8.5 19h4.5a3 3 0 0 0 3-3V9.5" />
    <path d="M15.5 5H11a3 3 0 0 0-3 3v1" />
  </Icon>
);

export const ChartIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Icon>
);

export const ReportIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </Icon>
);

export const ShieldIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3 5 6v5.5c0 4.2 2.8 7.9 7 9.5 4.2-1.6 7-5.3 7-9.5V6l-7-3Z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);

export const BellIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
    <path d="M10.5 20a2 2 0 0 0 3 0" />
  </Icon>
);

export const CameraIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 8.5 15 5v9L3 15.5Z" />
    <path d="m15 8 5-2v8l-5-2M6 15.5V19h4v-3" />
  </Icon>
);

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);

export const PlayIcon = (props: IconProps) => (
  <Icon {...props} fill="currentColor" stroke="none">
    <path d="M7 4.5v15l13-7.5Z" />
  </Icon>
);

export const PauseIcon = (props: IconProps) => (
  <Icon {...props} fill="currentColor" stroke="none">
    <path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" />
  </Icon>
);

export const SkipStartIcon = (props: IconProps) => (
  <Icon {...props} fill="currentColor" stroke="none">
    <path d="M6 4.5h2.5v15H6zM20 4.5v15L9.5 12Z" />
  </Icon>
);

export const SkipEndIcon = (props: IconProps) => (
  <Icon {...props} fill="currentColor" stroke="none">
    <path d="M15.5 4.5H18v15h-2.5zM4 4.5v15L14.5 12Z" />
  </Icon>
);

export const StepBackIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m14 6-6 6 6 6" />
  </Icon>
);

export const StepForwardIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m10 6 6 6-6 6" />
  </Icon>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m9 5 7 7-7 7" />
  </Icon>
);

export const ChevronLeftIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m15 5-7 7 7 7" />
  </Icon>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m5 9 7 7 7-7" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Icon>
);

export const WarningIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3.5 21 19H3Z" />
    <path d="M12 9.5v4.5M12 17h.01" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m5 12.5 5 5L19 7" />
  </Icon>
);

export const ClockIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

export const DownloadIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4v10M8 10.5l4 4 4-4M4.5 19h15" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const TargetIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
  </Icon>
);

export const LayersIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 13 9 5 9-5" />
  </Icon>
);

export const InfoIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </Icon>
);
