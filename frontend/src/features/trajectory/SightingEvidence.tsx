import {
  VALIDATION_LABEL,
  VALIDATION_TONE,
  formatConfidence,
} from '@/lib/congestion';
import { formatHeading } from '@/lib/geo';
import { formatPlate, plateDiffPositions } from '@/lib/plate';
import { formatDateTime } from '@/lib/time';
import { Badge, KeyValue, Meter } from '@/components/ui';
import type { Sighting } from '@/types/domain';

/** Human labels for the quality flags the OCR worker sets. */
const FLAG_LABELS: Record<string, string> = {
  night: 'Night',
  motion_blur: 'Motion blur',
  angled: 'Angled',
  occluded: 'Occluded',
  dirty_plate: 'Dirty plate',
};

/**
 * Evidence for one sighting.
 *
 * This is the screen where an operator decides whether to trust a read, so it
 * shows the disagreement rather than only the winner: every OCR candidate with its
 * confidence, the raw pre-normalisation string, the quality flags that explain a
 * low score, and the reason the validation step withheld the row. A UI that showed
 * only the chosen plate would make a 62%-confidence guess look like a fact.
 */
export function SightingEvidence({ sighting }: { sighting: Sighting }) {
  const flags = Object.entries(sighting.quality_flags).filter(([, value]) => value === true);
  const topCandidate = sighting.ocr_candidates[0]?.plate ?? null;
  const rawDiffers =
    sighting.raw_plate_text !== null &&
    sighting.raw_plate_text !== sighting.normalized_plate_candidate;

  return (
    <div className="evidence">
      <KeyValue
        rows={[
          {
            key: 'Resolved',
            value: (
              <span className="u-num">
                {sighting.normalized_plate
                  ? formatPlate(sighting.normalized_plate)
                  : '— not resolved'}
              </span>
            ),
          },
          {
            key: 'Status',
            value: (
              <Badge tone={VALIDATION_TONE[sighting.validation_status]}>
                {VALIDATION_LABEL[sighting.validation_status]}
              </Badge>
            ),
          },
          {
            key: 'Camera',
            value: (
              <span>
                <span className="u-num">{sighting.camera_code}</span> ·{' '}
                {sighting.camera_display_name}
              </span>
            ),
          },
          { key: 'Spotted', value: <span className="u-num">{formatDateTime(sighting.spotted_at)}</span> },
          { key: 'Processed', value: <span className="u-num">{formatDateTime(sighting.processed_at)}</span> },
          { key: 'Heading', value: <span className="u-num">{formatHeading(sighting.direction_degrees)}</span> },
          {
            key: 'Detection',
            value: <span className="u-num">{formatConfidence(sighting.detection_confidence)}</span>,
          },
          { key: 'Track', value: <span className="u-num">{sighting.camera_track_id ?? '—'}</span> },
          { key: 'Model', value: <span className="u-num">{sighting.model_version ?? '—'}</span> },
          { key: 'Event id', value: <span className="object-key">{sighting.source_event_id}</span> },
        ]}
      />

      {sighting.validation_reason ? (
        <div>
          <span className="u-label">Validation note</span>
          <p className="ui-field__hint">{sighting.validation_reason}</p>
        </div>
      ) : null}

      <div>
        <span className="u-label">OCR candidates</span>
        {sighting.ocr_candidates.length === 0 ? (
          <p className="ui-field__hint">
            No candidate cleared the confidence floor for this pass.
          </p>
        ) : (
          <div className="u-col" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-1)' }}>
            {sighting.ocr_candidates.map((candidate, index) => {
              // Highlight where the runner-up differs — usually a single
              // look-alike character, which is what makes the read contested.
              const diff = plateDiffPositions(candidate.plate, topCandidate);
              return (
                <div className="candidate" key={`${candidate.plate}-${index}`}>
                  <span
                    className={index === 0 ? 'candidate__plate candidate__plate--top' : 'candidate__plate'}
                  >
                    {formatPlate(candidate.plate)}
                    {index > 0 && diff.length > 0 ? (
                      <span className="u-dim">
                        {' '}
                        ({diff.length} char{diff.length === 1 ? '' : 's'} differ)
                      </span>
                    ) : null}
                  </span>
                  <span className="u-num u-dim">{formatConfidence(candidate.confidence)}</span>
                  <span className="candidate__bar">
                    <Meter
                      value={candidate.confidence}
                      color={index === 0 ? 'var(--c-accent)' : 'var(--c-text-dim)'}
                      label={`Confidence for ${candidate.plate}`}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {rawDiffers ? (
        <div>
          <span className="u-label">Raw OCR string</span>
          <p className="object-key">{sighting.raw_plate_text}</p>
          <p className="ui-field__hint">
            Differs from the normalised candidate — separators or a misread character.
          </p>
        </div>
      ) : null}

      <div>
        <span className="u-label">Capture conditions</span>
        <div className="flags" style={{ marginTop: 'var(--sp-1)' }}>
          {flags.length === 0 ? (
            <Badge tone="ok">clean capture</Badge>
          ) : (
            flags.map(([flag]) => (
              <Badge tone="warn" key={flag}>
                {FLAG_LABELS[flag] ?? flag}
              </Badge>
            ))
          )}
        </div>
      </div>

      <div>
        <span className="u-label">Evidence media</span>
        <div className="evidence-placeholder" style={{ marginTop: 'var(--sp-1)' }}>
          Media is stored in MinIO/S3 and referenced by object key only. Serving the
          crop and clip needs a signed-URL endpoint, which does not exist yet.
        </div>
        <div className="u-col" style={{ gap: 2, marginTop: 'var(--sp-2)' }}>
          {(
            [
              ['Plate crop', sighting.plate_crop_object_key],
              ['Vehicle image', sighting.vehicle_image_object_key],
              ['Context clip', sighting.context_clip_object_key],
            ] as const
          ).map(([label, key]) => (
            <span key={label} className="object-key">
              <span className="u-dim">{label}: </span>
              {key ?? 'not captured'}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
