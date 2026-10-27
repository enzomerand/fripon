import logoSource from '../assets/logo.svg?raw';

// Without the file's indentation, which would otherwise show up in the card's text.
const logoSvg = logoSource.replace(/>\s+</g, '><').trim();

/**
 * The Fripon fox. Inlined rather than linked so it shows inside Vinted's pages without exposing a
 * web-accessible resource. The SVG is our own static asset, never page content.
 */
export function Logo({ size = '1.25em' }: { size?: string }) {
  return (
    <span
      class="fripon-logo"
      aria-hidden="true"
      style={{ display: 'inline-block', flex: 'none', width: size, height: size, lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: logoSvg }}
    />
  );
}
