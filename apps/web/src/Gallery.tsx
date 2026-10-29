import { useEffect, useState } from 'react';
import { ART_VERSION, formatClock, type Artwork } from '@ampli-world/shared';
import { SourceBadge } from './Panel.tsx';

export function Gallery({ name, artVersion }: { name: string; artVersion: number }) {
  const [art, setArt] = useState<Artwork[]>([]);

  useEffect(() => {
    fetch('/api/art')
      .then((r) => (r.ok ? (r.json() as Promise<Artwork[]>) : []))
      .then(setArt)
      .catch(() => {});
  }, [artVersion]);

  if (art.length === 0) {
    return <p className="empty">{name} hasn’t made any art yet. It happens in the studio, when the mood strikes.</p>;
  }
  return (
    <div className="gallery">
      <p className="hint">
        Every picture is SVG code {name} wrote itself: shapes and colours, no image generator.
      </p>
      {art.map((a) => (
        <figure key={a.id} className="artwork">
          <img src={`/api/art/${a.id}.svg?v=${ART_VERSION}`} alt={`${a.title}: ${a.caption}`} loading="lazy" />
          <figcaption>
            <strong>{a.title}</strong>
            <span className="feed-time">{formatClock(a.simTime)}</span>
            <p>{a.caption}</p>
            {a.llm && <SourceBadge source="llm" llm={a.llm} />}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
