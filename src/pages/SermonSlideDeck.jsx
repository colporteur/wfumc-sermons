import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext.jsx';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import {
  fetchSlideImages,
  uploadAndAttachSlideImages,
  updateSlideImage,
  deleteSlideImage,
  publicSlideImageUrl,
  autoMatchByOrder,
  applyAutoMatchUpdates,
} from '../lib/sermonSlideImages';
import {
  findManuscriptSlideMarkers,
  paragraphPreview,
} from '../lib/paragraphs';

// /sermons/:id/slide-deck
//
// Reconciliation tool that pairs uploaded slide JPGs (the "finished
// deck") against <SLIDE #N – Description> markers in the manuscript.
// Pastor's typical workflow:
//
//   1. Build the deck in PowerPoint, polish visuals.
//   2. PowerPoint File → Export → JPG → Save All Slides.
//   3. Upload the JPGs here (multi-file).
//   4. Click "Auto-match by order" — pairs each image against the
//      markers in the manuscript by upload order.
//   5. Eyeball the matches. Override anything wrong via the
//      "Match to marker…" dropdown on each image.
//   6. Optionally delete bad images, re-upload, or attach an image
//      to a marker that doesn't have one yet.
export default function SermonSlideDeck() {
  const { id } = useParams();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sermon, setSermon] = useState(null);
  const [images, setImages] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);
  const [busyImageId, setBusyImageId] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);

  const fileInputRef = useRef(null);

  // Markers parsed from the live manuscript.
  const markers = useMemo(
    () => findManuscriptSlideMarkers(sermon?.manuscript_text || ''),
    [sermon?.manuscript_text]
  );
  // Sort by number for stable display.
  const sortedMarkers = useMemo(
    () => [...markers].sort((a, b) => a.number - b.number),
    [markers]
  );

  // For each marker, find its currently-matched image (if any).
  // Multiple images claiming the same marker is rare but possible —
  // we show the lowest-sort_order one and a duplicate warning later.
  const markerToImage = useMemo(() => {
    const map = new Map();
    const sortedImages = [...images].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    );
    for (const img of sortedImages) {
      if (img.matched_marker_number == null) continue;
      if (!map.has(img.matched_marker_number)) {
        map.set(img.matched_marker_number, img);
      }
    }
    return map;
  }, [images]);

  // Which images aren't matched to any marker (for the unmatched tray).
  const unmatchedImages = useMemo(
    () =>
      images
        .filter((img) => img.matched_marker_number == null)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [images]
  );

  // Reconciliation completeness for the badge.
  const totalMarkers = sortedMarkers.length;
  const matchedMarkers = sortedMarkers.filter((m) =>
    markerToImage.has(m.number)
  ).length;
  const reconciled =
    totalMarkers > 0 &&
    matchedMarkers === totalMarkers &&
    unmatchedImages.length === 0;

  // --- Initial load -------------------------------------------------

  useEffect(() => {
    if (!id || !user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [sermonRes, imagesRes] = await Promise.all([
          withTimeout(
            supabase
              .from('sermons')
              .select(
                'id, title, scripture_reference, manuscript_text, owner_user_id'
              )
              .eq('id', id)
              .eq('owner_user_id', user.id)
              .single()
          ),
          fetchSlideImages(id),
        ]);
        if (sermonRes.error) throw sermonRes.error;
        if (cancelled) return;
        setSermon(sermonRes.data);
        setImages(imagesRes);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, user?.id]);

  // --- Actions -----------------------------------------------------

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    if (!sermon?.id || !user?.id) {
      setError('Missing sermon or user.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const startOrder = images.length;
      const created = await uploadAndAttachSlideImages({
        files,
        sermonId: sermon.id,
        ownerUserId: user.id,
        startOrder,
      });
      setImages((prev) => [...prev, ...created]);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleAutoMatch = async () => {
    if (sortedMarkers.length === 0) {
      setError(
        'No <SLIDE> markers found in the manuscript. Add markers first (Workspace → Slides panel → Insert markers).'
      );
      return;
    }
    if (
      !window.confirm(
        `Auto-match ${images.length} image${images.length === 1 ? '' : 's'} to ${sortedMarkers.length} marker${sortedMarkers.length === 1 ? '' : 's'}?\n\n` +
          'Each image (in upload order) is paired with one marker (by number). Existing matches are overwritten.'
      )
    ) {
      return;
    }
    setAutoMatching(true);
    setError(null);
    try {
      const { updates } = autoMatchByOrder(images, sortedMarkers);
      await applyAutoMatchUpdates(updates);
      // Optimistically apply the matches in local state.
      setImages((prev) => {
        const map = new Map(prev.map((img) => [img.id, img]));
        for (const u of updates) {
          const cur = map.get(u.id);
          if (cur) {
            map.set(u.id, {
              ...cur,
              matched_marker_number: u.matched_marker_number,
              matched_marker_description: u.matched_marker_description,
            });
          }
        }
        // Also clear matches for images NOT in updates (they got dropped
        // because there were more images than markers).
        const updatedIds = new Set(updates.map((u) => u.id));
        for (const img of prev) {
          if (!updatedIds.has(img.id) && img.matched_marker_number != null) {
            map.set(img.id, {
              ...img,
              matched_marker_number: null,
              matched_marker_description: null,
            });
          }
        }
        return Array.from(map.values());
      });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setAutoMatching(false);
    }
  };

  // Set a single image's match. If the target marker number is already
  // claimed by another image, clear that other image's match first.
  const handleSetMatch = async (image, markerNumber) => {
    setBusyImageId(image.id);
    setError(null);
    try {
      // Find the marker description for context.
      const marker =
        markerNumber == null
          ? null
          : sortedMarkers.find((m) => m.number === markerNumber);
      // Clear other claimants on this marker number.
      const others =
        markerNumber == null
          ? []
          : images.filter(
              (i) =>
                i.id !== image.id &&
                i.matched_marker_number === markerNumber
            );
      for (const other of others) {
        await updateSlideImage(other.id, {
          matched_marker_number: null,
          matched_marker_description: null,
        });
      }
      const updated = await updateSlideImage(image.id, {
        matched_marker_number: markerNumber,
        matched_marker_description: marker ? marker.description : null,
      });
      setImages((prev) =>
        prev.map((i) => {
          if (i.id === image.id) return updated;
          if (others.some((o) => o.id === i.id)) {
            return {
              ...i,
              matched_marker_number: null,
              matched_marker_description: null,
            };
          }
          return i;
        })
      );
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyImageId(null);
    }
  };

  const handleDeleteImage = async (image) => {
    if (
      !window.confirm(
        `Delete slide image #${image.sort_order + 1}${image.original_filename ? ` (${image.original_filename})` : ''}?`
      )
    ) {
      return;
    }
    setBusyImageId(image.id);
    setError(null);
    try {
      await deleteSlideImage(image);
      setImages((prev) => prev.filter((i) => i.id !== image.id));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyImageId(null);
    }
  };

  // --- Render ------------------------------------------------------

  if (loading) return <LoadingSpinner label="Loading slide deck…" />;
  if (!sermon) {
    return (
      <div className="card text-center text-sm text-gray-500">
        Sermon not found, or not visible to you.
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-5xl">
      {/* Top bar */}
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <Link
            to={`/sermons/${sermon.id}`}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← {sermon.title || 'Sermon'}
          </Link>
          <h1 className="font-serif text-2xl text-umc-900 mt-1">
            Slide Deck
            <span className="ml-2 text-base font-normal text-gray-500">
              {sermon.title || '(untitled)'}
            </span>
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {sermon.scripture_reference || 'No scripture set'} ·{' '}
            <ReconciliationBadge
              total={totalMarkers}
              matched={matchedMarkers}
              unmatchedImages={unmatchedImages.length}
              reconciled={reconciled}
            />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleUpload}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="btn-primary text-xs disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : '⬆ Upload images'}
          </button>
          <button
            type="button"
            onClick={handleAutoMatch}
            disabled={
              autoMatching || images.length === 0 || sortedMarkers.length === 0
            }
            className="btn-secondary text-xs disabled:opacity-50"
            title={
              sortedMarkers.length === 0
                ? 'No markers in the manuscript yet.'
                : 'Pair each image (in upload order) with a marker (by number).'
            }
          >
            {autoMatching ? 'Matching…' : '🔗 Auto-match by order'}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      {/* Helpful onboarding for first-timers */}
      {images.length === 0 && (
        <div className="card text-sm text-gray-700 space-y-2">
          <p>
            <strong>Upload the JPGs</strong> you exported from PowerPoint
            (File → Export → JPG → "All Slides"). They land here in
            upload order.
          </p>
          <p>
            Then click <strong>Auto-match by order</strong> and the app
            pairs each image with a <code>&lt;SLIDE #N&gt;</code> marker
            in the manuscript. Override any individual match using the
            dropdown next to each image.
          </p>
          <p className="text-xs text-gray-500">
            {sortedMarkers.length === 0 ? (
              <>
                Heads up: this sermon's manuscript doesn't contain any{' '}
                <code>&lt;SLIDE&gt;</code> markers yet. Open the
                Workspace and use the Slides panel's <em>Insert markers</em>{' '}
                button to add them — or you can upload images now and
                match them later.
              </>
            ) : (
              <>
                {sortedMarkers.length} <code>&lt;SLIDE&gt;</code>{' '}
                marker{sortedMarkers.length === 1 ? '' : 's'} found in
                the manuscript.
              </>
            )}
          </p>
        </div>
      )}

      {/* Per-marker grid: each marker gets a row showing its image (or empty) */}
      {sortedMarkers.length > 0 && (
        <div className="card space-y-3">
          <h2 className="font-serif text-lg text-umc-900">
            Manuscript markers
            <span className="ml-2 text-sm font-normal text-gray-500">
              ({matchedMarkers} of {totalMarkers} matched)
            </span>
          </h2>
          <ul className="space-y-2">
            {sortedMarkers.map((marker) => {
              const img = markerToImage.get(marker.number);
              return (
                <MarkerRow
                  key={marker.number + '-' + marker.paragraphIdx}
                  marker={marker}
                  image={img}
                  unmatchedImages={unmatchedImages}
                  busyImageId={busyImageId}
                  onAttach={(image) => handleSetMatch(image, marker.number)}
                  onDetach={(image) => handleSetMatch(image, null)}
                  onDelete={(image) => handleDeleteImage(image)}
                  onPreview={(image) => setPreviewImage(image)}
                />
              );
            })}
          </ul>
        </div>
      )}

      {/* Unmatched images tray */}
      {unmatchedImages.length > 0 && (
        <div className="card space-y-3">
          <h2 className="font-serif text-lg text-umc-900">
            Unmatched images
            <span className="ml-2 text-sm font-normal text-gray-500">
              ({unmatchedImages.length})
            </span>
          </h2>
          <p className="text-xs text-gray-500">
            These uploaded images aren't paired with a manuscript marker
            yet. Use the dropdown to match each one, or delete if it's
            extra.
          </p>
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {unmatchedImages.map((img) => (
              <UnmatchedImageCard
                key={img.id}
                image={img}
                markers={sortedMarkers}
                busy={busyImageId === img.id}
                onMatch={(n) => handleSetMatch(img, n)}
                onDelete={() => handleDeleteImage(img)}
                onPreview={() => setPreviewImage(img)}
              />
            ))}
          </ul>
        </div>
      )}

      {/* Full-size preview modal */}
      {previewImage && (
        <ImagePreviewModal
          image={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </div>
  );
}

// --- Subcomponents -------------------------------------------------

function ReconciliationBadge({ total, matched, unmatchedImages, reconciled }) {
  if (total === 0 && unmatchedImages === 0) {
    return <span className="text-gray-400">no slides yet</span>;
  }
  if (reconciled) {
    return <span className="text-green-700">✓ reconciled</span>;
  }
  return (
    <span className="text-amber-700">
      {matched}/{total} matched
      {unmatchedImages > 0 && `, ${unmatchedImages} extra image${unmatchedImages === 1 ? '' : 's'}`}
    </span>
  );
}

function MarkerRow({
  marker,
  image,
  unmatchedImages,
  busyImageId,
  onAttach,
  onDetach,
  onDelete,
  onPreview,
}) {
  const busy = image && busyImageId === image.id;
  return (
    <li className="flex items-start gap-3 border-b border-gray-100 pb-3 last:border-b-0">
      <div className="text-xs text-gray-500 w-20 shrink-0 pt-1">
        SLIDE #{marker.number}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-umc-900">
          {marker.description}
        </p>
        <p className="text-[10px] text-gray-400 mt-0.5">
          ¶{marker.paragraphIdx + 1}: {paragraphPreview(marker.paragraphText, 80)}
        </p>
      </div>
      <div className="shrink-0">
        {image ? (
          <div className="flex items-start gap-2">
            <button
              type="button"
              onClick={() => onPreview(image)}
              className="block focus:outline-none focus:ring-2 focus:ring-umc-700"
              title={image.original_filename || 'click to view full-size'}
            >
              <img
                src={publicSlideImageUrl(image.image_path)}
                alt=""
                className="w-32 h-20 object-cover rounded border border-gray-300"
                loading="lazy"
              />
            </button>
            <div className="flex flex-col gap-1 text-xs">
              <button
                type="button"
                onClick={() => onDetach(image)}
                disabled={busy}
                className="text-gray-600 hover:text-gray-900 underline disabled:opacity-40"
                title="Unmatch this image from the marker (the image stays in the deck, just unmatched)."
              >
                Detach
              </button>
              <button
                type="button"
                onClick={() => onDelete(image)}
                disabled={busy}
                className="text-red-600 hover:text-red-800 underline disabled:opacity-40"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <AttachPicker
            unmatchedImages={unmatchedImages}
            onAttach={onAttach}
          />
        )}
      </div>
    </li>
  );
}

function AttachPicker({ unmatchedImages, onAttach }) {
  if (unmatchedImages.length === 0) {
    return (
      <span className="text-xs text-gray-400 italic block w-32 text-center py-3 border border-dashed border-gray-300 rounded">
        no images to attach
      </span>
    );
  }
  return (
    <select
      defaultValue=""
      onChange={(e) => {
        const v = e.target.value;
        if (!v) return;
        const img = unmatchedImages.find((i) => i.id === v);
        if (img) onAttach(img);
        e.target.value = '';
      }}
      className="text-xs border border-gray-300 rounded px-2 py-1 bg-white"
    >
      <option value="" disabled>
        Attach an image…
      </option>
      {unmatchedImages.map((img) => (
        <option key={img.id} value={img.id}>
          {img.original_filename || `image #${img.sort_order + 1}`}
        </option>
      ))}
    </select>
  );
}

function UnmatchedImageCard({ image, markers, busy, onMatch, onDelete, onPreview }) {
  return (
    <li className="border border-gray-200 rounded p-2 space-y-2">
      <button
        type="button"
        onClick={onPreview}
        className="block w-full focus:outline-none focus:ring-2 focus:ring-umc-700"
        title={image.original_filename || 'click to view full-size'}
      >
        <img
          src={publicSlideImageUrl(image.image_path)}
          alt=""
          className="w-full h-32 object-cover rounded"
          loading="lazy"
        />
      </button>
      <p className="text-[10px] text-gray-500 truncate" title={image.original_filename || ''}>
        {image.original_filename || `image #${image.sort_order + 1}`}
      </p>
      <select
        defaultValue=""
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          onMatch(Number(v));
          e.target.value = '';
        }}
        disabled={busy}
        className="text-xs border border-gray-300 rounded px-2 py-1 bg-white w-full"
      >
        <option value="" disabled>
          Match to marker…
        </option>
        {markers.map((m) => (
          <option key={m.number} value={String(m.number)}>
            #{m.number} — {m.description.slice(0, 30)}
            {m.description.length > 30 ? '…' : ''}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        className="text-xs text-red-600 hover:text-red-800 underline disabled:opacity-40"
      >
        {busy ? '…' : 'Delete'}
      </button>
    </li>
  );
}

function ImagePreviewModal({ image, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white max-w-5xl max-h-[90vh] rounded shadow-xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2 border-b border-gray-200 flex items-baseline justify-between gap-2">
          <span className="text-sm text-gray-700 truncate">
            {image.original_filename || `Slide #${image.sort_order + 1}`}
            {image.matched_marker_number != null && (
              <span className="ml-2 text-xs text-gray-500">
                matched to SLIDE #{image.matched_marker_number}
                {image.matched_marker_description &&
                  ` — ${image.matched_marker_description}`}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-sm"
          >
            Close
          </button>
        </div>
        <div className="overflow-auto p-2 bg-gray-100">
          <img
            src={publicSlideImageUrl(image.image_path)}
            alt=""
            className="max-w-full h-auto"
          />
        </div>
      </div>
    </div>
  );
}
