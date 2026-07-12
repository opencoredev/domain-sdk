export const DOMAINS_QUERY = `query DomainSdkDomains($projectId: String!, $environmentId: String!, $serviceId: String!) {
  domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
    customDomains {
      id
      domain
      status {
        verificationToken
        dnsRecords { hostlabel requiredValue currentValue status }
      }
    }
  }
}`;

export const DOMAIN_AVAILABLE_QUERY = `query DomainSdkCustomDomainAvailable($domain: String!) {
  customDomainAvailable(domain: $domain) { available message }
}`;

export const DOMAIN_CREATE_MUTATION = `mutation DomainSdkCustomDomainCreate($input: CustomDomainCreateInput!) {
  customDomainCreate(input: $input) {
    id
    domain
    status {
      verificationToken
      dnsRecords { hostlabel requiredValue currentValue status }
      certificateStatus
    }
  }
}`;

export const DOMAIN_QUERY = `query DomainSdkCustomDomain($id: String!, $projectId: String!) {
  customDomain(id: $id, projectId: $projectId) {
    id
    domain
    status {
      verificationToken
      dnsRecords { hostlabel requiredValue currentValue status }
      certificateStatus
    }
  }
}`;

export const DOMAIN_DELETE_MUTATION = `mutation DomainSdkCustomDomainDelete($id: String!) {
  customDomainDelete(id: $id)
}`;
