export interface ServiceDidDoc {
  "@context": string[];
  id: string;
  service: Array<{ id: string; type: string; serviceEndpoint: string }>;
}

export const OPENSOCIAL_SERVICE_FRAGMENT = "#opensocial";

/**
 * DID document for OpenSocial's own service identity (did:web).
 * The group PDS resolves `managingApp` (did + fragment) through this
 * document to find where to send checkUserAccess.
 */
export function buildServiceDidDoc(opts: {
  serviceDid: string;
  serviceEndpoint: string;
}): ServiceDidDoc {
  return {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: opts.serviceDid,
    service: [
      {
        id: OPENSOCIAL_SERVICE_FRAGMENT,
        type: "OpenSocialCommunityManagement",
        serviceEndpoint: opts.serviceEndpoint,
      },
    ],
  };
}
