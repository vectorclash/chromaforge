import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Button from './Button';
import { useStudio } from '../../context/StudioContext';
import { useAuth } from '../../context/AuthContext';

// Ambient presence of the generator on every light page: a small floating widget with a live
// thumbnail of the current design plus Generate/Save. Rendered once in SiteLayout. The
// thumbnail and the footer's art band both read the same StudioContext.previewUrl, so
// regenerating here updates both at once -- that shared reactivity is the point.
export default function MiniGenerator() {
  const { previewUrl, currentDesign, generateRandom, saveCurrentDesign } = useStudio();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [pending, setPending] = useState(false);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const prevDesignRef = useRef(currentDesign);

  // Clear the "pending" (regenerating) flag once previewUrl actually catches up to a new
  // currentDesign, rather than guessing at render duration.
  useEffect(() => {
    if (currentDesign !== prevDesignRef.current) {
      prevDesignRef.current = currentDesign;
    } else {
      setPending(false);
    }
  }, [previewUrl, currentDesign]);

  const onGenerate = () => {
    setPending(true);
    generateRandom();
  };

  const onSave = async () => {
    if (!user) {
      navigate('/account');
      return;
    }
    setSaveState('saving');
    try {
      await saveCurrentDesign('image', currentDesign);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 2500);
    }
  };

  return (
    <div className="fixed bottom-6 right-6 z-30 flex flex-col items-center gap-2 rounded-xl border border-neutral-200 bg-white/95 p-3 shadow-lg backdrop-blur">
      <Link to="/" className="block h-20 w-20 overflow-hidden rounded-lg bg-neutral-100">
        {previewUrl && (
          <img
            src={previewUrl}
            alt="Current design — open studio"
            className={'h-full w-full object-cover transition ' + (pending ? 'opacity-50' : 'opacity-100')}
          />
        )}
      </Link>
      <div className="flex gap-1.5">
        <Button size="sm" variant="secondary" onClick={onGenerate} disabled={pending}>
          {pending ? '…' : 'Generate'}
        </Button>
        <Button size="sm" variant="primary" onClick={onSave} disabled={saveState === 'saving'}>
          {saveState === 'saving' && 'Saving…'}
          {saveState === 'saved' && 'Saved'}
          {saveState === 'error' && 'Failed'}
          {saveState === 'idle' && 'Save'}
        </Button>
      </div>
    </div>
  );
}
