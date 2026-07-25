import FadeImage from './FadeImage';
import HexagonIcon from '../buttons/HexagonIcon';

// The "by <someone>" credit that appears under every public design, now with the author's
// avatar. Shared by all four surfaces that show it (GalleryPage, the homepage
// GallerySection, GalleryModal, ArtworkPickerModal's public tab) -- the markup was
// duplicated four times before this, and the avatar policy below is exactly the kind of
// rule that must not exist in four copies.
//
// No new query: listPublicDesigns/listTopLikedDesigns already embed
// profiles!designs_user_id_fkey(username, display_name, avatar_url) -- see lib/designs.js --
// so the avatar was already arriving with every card and simply wasn't rendered.
//
// PRIVACY RULE, the reason this isn't just <img src={avatar_url}>: a profile's avatar_url
// is EITHER an avatar this app generated and stores in its own `avatars` bucket, OR
// whatever URL an OAuth provider handed us at sign-up (Google's is on
// lh3.googleusercontent.com -- see lib/profiles.js). Rendering the latter on a PUBLIC page
// makes every visitor's browser request an image from Google, handing Google their IP and
// the referring URL. That is a third-party request on a site whose Privacy page promises no
// trackers (the same promise regionGuess.js's timezone-based guess exists to keep), and
// it's a different exposure from showing someone their OWN OAuth avatar in the header,
// which only ever talks to Google from that person's own browser.
// It's also a consent question: signing in with Google is not obviously the same as
// agreeing to have your Google profile photo -- often a real face -- published next to your
// work in a public gallery.
// So only self-hosted avatars render publicly; anything else falls back to the same hexagon
// placeholder the signed-out header uses, and the author can get a real avatar any time by
// generating one on the Account page. To show provider avatars publicly instead, delete the
// isSelfHosted check below -- but read the paragraph above first.
//
// Matched against this project's OWN Storage origin, not just the `/avatars/` path: a user
// can PATCH their own profiles row (RLS is write-owner-only, and avatar_url is a free-text
// column), so a bare substring test would let anyone point avatar_url at
// https://their-server.example/storage/v1/object/public/avatars/x.jpg and get a tracking
// pixel loaded from every visitor's browser on the public gallery -- the exact thing this
// rule exists to prevent. Caught by testing the predicate against a deliberate lookalike.
const SELF_HOSTED_AVATAR_PREFIX = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/avatars/`;

function isSelfHosted(url) {
  return typeof url === 'string' && url.startsWith(SELF_HOSTED_AVATAR_PREFIX);
}

export function authorName(profile) {
  return profile?.display_name || profile?.username || 'someone';
}

export default function AuthorBadge({ profile, size = 'sm', className = '' }) {
  if (!profile) return null;
  const large = size === 'md';
  const src = isSelfHosted(profile.avatar_url) ? profile.avatar_url : null;
  return (
    <span
      className={
        'flex min-w-0 items-center gap-1.5 ' +
        (large ? 'text-sm text-text-secondary ' : 'text-xs text-text-secondary ') +
        className
      }
    >
      {/* Same circle treatment as SiteHeader's account avatar, just smaller: fixed size,
          shrink-0 so a long name can't squash it, overflow-hidden + object-cover so a
          non-square source can't distort. */}
      <span
        className={
          'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink-700 ' +
          (large ? 'h-6 w-6' : 'h-4 w-4')
        }
      >
        {src ? (
          <FadeImage src={src} alt="" className="h-full w-full object-cover" />
        ) : (
          <HexagonIcon size={large ? 13 : 9} className="text-text-secondary" />
        )}
      </span>
      {/* "by" is dropped visually: with the avatar sitting right there, the preposition
          only served to split the pair it was meant to connect (avatar, "by", name reads as
          three things rather than one attribution). It stays for assistive tech, where
          there is no avatar to imply authorship -- the image is decorative with alt="", so
          a screen reader would otherwise hear a bare name with no relationship to the
          design. ArtworkPickerModal keeps a visible "by" precisely because it shows no
          avatar. */}
      <span className="truncate">
        <span className="sr-only">by </span>
        {authorName(profile)}
      </span>
    </span>
  );
}
