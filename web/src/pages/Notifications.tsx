import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useApi } from '../lib/live';
import { timeAgo } from '../lib/format';
import { Card, Empty, ErrorState, Loading, Seg, cx, useAction } from '../components/ui';

const SEV_LABEL: Record<string, string> = { critical: 'Critical', warning: 'Warning', notice: 'Heads-up', info: 'Update' };

export function Notifications() {
  const [filter, setFilter] = useState<'all' | 'unread'>('unread');
  const { data, error, reload } = useApi<any[]>(`/notifications?filter=${filter}`, ['notifications']);
  const { run } = useAction();
  const nav = useNavigate();
  const open = (n: any) => {
    if (!n.read_at) api.post(`/notifications/${n.id}/read`);
    if (n.link) nav(n.link);
  };
  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow">Overview</div><h1>Notifications</h1><div className="sub">Overdue orders, material shortages, approaching deadlines and completed work.</div></div>
        <div className="row">
          <Seg value={filter} onChange={setFilter} items={[{ key: 'unread', label: 'Unread' }, { key: 'all', label: 'All' }]} />
          <button className="btn" onClick={() => run(() => api.post('/notifications/read-all'), 'All marked as read')}><CheckCheck size={15} /> Mark all read</button>
        </div>
      </div>
      {error ? <ErrorState error={error} retry={reload} /> : !data ? <Loading rows={6} h={56} /> : (
        <Card pad={false}>
          {data.length === 0 ? <Empty title={filter === 'unread' ? "You're all caught up" : 'No notifications yet'} /> : data.map((n) => (
            <div key={n.id} className={cx('notif', !n.read_at && 'unread')} onClick={() => open(n)} role="button" tabIndex={0}>
              <span className={cx('sev', n.severity)} aria-label={SEV_LABEL[n.severity]} />
              <div>
                <div className={n.read_at ? '' : 'strong'}>{n.title}</div>
                {n.body && <div className="small muted">{n.body}</div>}
                <div className="tiny muted" style={{ marginTop: 2 }}>{SEV_LABEL[n.severity]}</div>
              </div>
              <div className="small muted nowrap">{timeAgo(n.created_at)}</div>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
