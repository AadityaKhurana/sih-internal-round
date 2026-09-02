import { Link } from 'react-router-dom';

import { EmptyState } from '@/components/ui';

export function NotFoundPage() {
  return (
    <div className="page">
      <EmptyState
        icon="404"
        title="No such screen"
        body="That route does not exist in the dashboard."
        action={<Link to="/map">Back to the live map</Link>}
      />
    </div>
  );
}
