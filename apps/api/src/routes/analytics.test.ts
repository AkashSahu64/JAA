import { describe, expect, it } from 'vitest';
import { analyticsStatusPolicy, averageElapsedHours, classifyAtsScore, groupApplicationsByDateAndStatus, parseAnalyticsDays, summarizeInterviewRounds, summarizeOfferOutcomes } from './analytics';

describe('analytics funnel aggregation', () => {
  it('counts terminal and positive lifecycle outcomes as responses', () => {
    expect(analyticsStatusPolicy()).toEqual({
      responseStatuses: ['REJECTED', 'INTERVIEW', 'OFFER', 'ACCEPTED', 'WITHDRAWN'],
      interviewStatuses: ['INTERVIEW', 'OFFER', 'ACCEPTED'],
      offerStatuses: ['OFFER', 'ACCEPTED'],
    });
  });

  it('groups real application lifecycle states by UTC date without relying on array order', () => {
    expect(groupApplicationsByDateAndStatus([
      { createdAt: new Date('2026-09-14T12:00:00Z'), status: 'INTERVIEW' },
      { createdAt: new Date('2026-09-13T12:00:00Z'), status: 'READY' },
      { createdAt: new Date('2026-09-14T13:00:00Z'), status: 'INTERVIEW' },
    ])).toEqual([
      { date: '2026-09-13', total: 1, statuses: { READY: 1 } },
      { date: '2026-09-14', total: 2, statuses: { INTERVIEW: 2 } },
    ]);
  });

  it('does not retain application objects or answer content', () => {
    const result = groupApplicationsByDateAndStatus([{ createdAt: new Date('2026-09-14T12:00:00Z'), status: 'FAILED' }]);
    expect(JSON.stringify(result)).not.toContain('applicationId');
  });

  it('defines durable performance metrics as confirmed outcomes, not submit attempts', () => {
    expect(analyticsStatusPolicy().responseStatuses).toContain('OFFER');
    expect(analyticsStatusPolicy().responseStatuses).not.toContain('CONFIRMED');
  });

  it('ignores malformed runtime rows instead of throwing or fabricating metrics', () => {
    expect(groupApplicationsByDateAndStatus([
      { createdAt: new Date('invalid'), status: 'FAILED' },
      { createdAt: new Date('2026-09-14T12:00:00Z'), status: 42 as never },
      { createdAt: new Date('2026-09-14T12:00:00Z'), status: 'CONFIRMED' },
    ])).toEqual([{ date: '2026-09-14', total: 1, statuses: { CONFIRMED: 1 } }]);
  });

  it('ignores malformed ATS scores instead of assigning false performance buckets', () => {
    expect(classifyAtsScore(-1)).toBeNull();
    expect(classifyAtsScore(101)).toBeNull();
    expect(classifyAtsScore(Number.NaN)).toBeNull();
    expect(classifyAtsScore(89)).toBe('from80To89');
  });

  it('accepts only bounded scalar day-window query values', () => {
    expect(parseAnalyticsDays(undefined)).toBe(30);
    expect(parseAnalyticsDays('365')).toBe(365);
    expect(parseAnalyticsDays(['30'])).toBeNull();
    expect(parseAnalyticsDays('30.0')).toBeNull();
    expect(parseAnalyticsDays('366')).toBeNull();
  });

  it('averages only coherent application-to-submission intervals', () => {
    expect(averageElapsedHours([
      { startedAt: new Date('2026-09-14T00:00:00Z'), endedAt: new Date('2026-09-14T02:00:00Z') },
      { startedAt: new Date('2026-09-14T00:00:00Z'), endedAt: new Date('2026-09-14T01:00:00Z') },
      { startedAt: new Date('invalid'), endedAt: new Date('2026-09-14T01:00:00Z') },
      { startedAt: new Date('2026-09-14T02:00:00Z'), endedAt: new Date('2026-09-14T01:00:00Z') },
    ])).toBe(1.5);
  });

  it('aggregates durable interview rounds and offer outcomes without trusting malformed rows', () => {
    expect(summarizeInterviewRounds([{ round: 1 }, { round: 2 }, { round: 2 }, { round: 0 }, { round: 101 }, { round: Number.NaN }])).toEqual({ total: 3, highestRound: 2, byRound: { '1': 1, '2': 2 } });
    expect(summarizeOfferOutcomes([{ status: 'PENDING' }, { status: 'ACCEPTED' }, { status: 'ACCEPTED' }, { status: 'bad status' }, { status: '' }])).toEqual({ total: 3, byStatus: { PENDING: 1, ACCEPTED: 2 } });
  });
});
