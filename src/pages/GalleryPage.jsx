import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { listPublicDesigns, listMyDesigns, deleteDesign, getThumbnailUrl } from '../lib/designs';
import { generateShareUrl } from '../utils/urlConfig';
import { useAuth } from '../context/AuthContext';

const PAGE_SIZE = 20;

export default function GalleryPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('public');
  const [designs, setDesigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async which => {
    setLoading(true);
    setError(null);
    setHasMore(false);
    try {
      const rows =
        which === 'mine' ? await listMyDesigns() : await listPublicDesigns({ limit: PAGE_SIZE });
      setDesigns(rows);
      setHasMore(which === 'public' && rows.length === PAGE_SIZE);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(tab);
  }, [tab, load]);

  const onLoadMore = async () => {
    const cursor = designs[designs.length - 1]?.created_at;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const more = await listPublicDesigns({ limit: PAGE_SIZE, before: cursor });
      setDesigns(d => [...d, ...more]);
      setHasMore(more.length === PAGE_SIZE);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const onDelete = async (e, design) => {
    e.stopPropagation();
    if (!window.confirm('Delete this design? This can’t be undone.')) return;
    try {
      await deleteDesign(design.id);
      setDesigns(d => d.filter(x => x.id !== design.id));
    } catch (err) {
      setError(err.message);
    }
  };

  // Load a saved design into the studio by routing to its share URL -- the studio's
  // existing getConfigFromUrl path reconstructs it on mount.
  const onOpen = design => {
    const url = generateShareUrl(design.data);
    const query = url && url.includes('?') ? url.slice(url.indexOf('?')) : '';
    navigate('/' + query);
  };

  const tabClass = active =>
    'font-quicksand text-sm pb-2 border-b-2 transition ' +
    (active ? 'border-accent text-neutral-900' : 'border-transparent text-neutral-500 hover:text-neutral-900');

  return (
    <PageContainer title="Gallery" subtitle="Designs saved by the community and by you.">
      <div className="mb-6 flex gap-6 border-b border-neutral-200">
        <button className={tabClass(tab === 'public')} onClick={() => setTab('public')}>
          Public
        </button>
        {user && (
          <button className={tabClass(tab === 'mine')} onClick={() => setTab('mine')}>
            My designs
          </button>
        )}
      </div>

      {loading && <p className="text-neutral-500">Loading…</p>}
      {error && <p className="text-accent">{error}</p>}
      {!loading && !error && designs.length === 0 && (
        <p className="text-neutral-500">
          {tab === 'mine' ? 'You haven’t saved any designs yet.' : 'No public designs yet.'}
        </p>
      )}

      {!loading && designs.length > 0 && (
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
          {designs.map(design => (
            <Card key={design.id} className="group cursor-pointer" onClick={() => onOpen(design)}>
              <div className="aspect-square overflow-hidden bg-neutral-100">
                <img
                  src={getThumbnailUrl(design.user_id, design.id)}
                  alt={design.title || 'Untitled design'}
                  onError={e => {
                    e.target.style.visibility = 'hidden';
                  }}
                  className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                />
              </div>
              <div className="flex items-center justify-between p-3">
                <span className="truncate text-sm text-neutral-700">
                  {design.title || (design.kind === 'animation' ? 'Untitled animation' : 'Untitled')}
                </span>
                {tab === 'mine' && (
                  <button
                    onClick={e => onDelete(e, design)}
                    className="ml-2 shrink-0 text-xs text-neutral-400 hover:text-accent"
                    aria-label="Delete design"
                  >
                    Delete
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === 'public' && hasMore && (
        <div className="mt-8 text-center">
          <Button variant="secondary" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </PageContainer>
  );
}
