import {
  GreenhouseApplicationAdapter,
  type ApprovedGreenhouseProfile,
  type GreenhouseField,
  type GreenhouseFillResult,
  type GreenhouseFormPort,
  type GreenhouseFormSnapshot,
} from './greenhouse';

/** Lever uses the same fail-closed generic form contract as Greenhouse. */
export type LeverField = GreenhouseField;
export type LeverFormSnapshot = GreenhouseFormSnapshot;
export type ApprovedLeverProfile = ApprovedGreenhouseProfile;
export type LeverFormPort = GreenhouseFormPort;
export type LeverFillResult = GreenhouseFillResult;

/**
 * Provider boundary for Lever forms. It intentionally inherits only generic,
 * policy-controlled field handling: it never submits, uploads, or invents answers.
 */
export class LeverApplicationAdapter extends GreenhouseApplicationAdapter {}
