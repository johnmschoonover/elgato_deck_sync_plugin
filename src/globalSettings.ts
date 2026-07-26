// Global settings schema for Deck Sync plugin

export interface Scope {
  id: string;
  name: string;
  /** List of device IDs that belong to this scope */
  deviceIds: string[];
}

export interface Role {
  id: string;
  name: string;
  /** Description of what this role does */
  description?: string;
}

export interface Mapping {
  id: string;
  scopeId: string;
  /** Source profile name (on primary device) */
  sourceProfile: string;
  /** Target profile name (on secondary devices) */
  targetProfile: string;
  /** Whether this mapping is enabled */
  enabled?: boolean;
}

export interface GlobalSettings {
  /** Version of the settings schema */
  version: string;
  /** List of device scopes */
  scopes: Scope[];
  /** List of device roles */
  roles: Role[];
  /** List of profile mappings */
  mappings: Mapping[];
  /** Default settings for new actions */
  defaultActionSettings: {
    targetDeviceId: string;
    targetProfile: string;
    enabled: boolean;
  };
}

/**
 * Validates GlobalSettings from JSON object
 * @throws {Error} if JSON is invalid or doesn't match schema
 */
export function validateGlobalSettings(parsed: any): GlobalSettings {
  // Basic validation
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid GlobalSettings: root must be an object');
  }

  if (!parsed.version || typeof parsed.version !== 'string') {
    throw new Error('Invalid GlobalSettings: missing or invalid version');
  }

  if (!Array.isArray(parsed.scopes)) {
    throw new Error('Invalid GlobalSettings: scopes must be an array');
  }

  if (!Array.isArray(parsed.roles)) {
    throw new Error('Invalid GlobalSettings: roles must be an array');
  }

  if (!Array.isArray(parsed.mappings)) {
    throw new Error('Invalid GlobalSettings: mappings must be an array');
  }

  // Validate each scope
  parsed.scopes.forEach((scope: any, index: number) => {
    if (!scope || typeof scope !== 'object') {
      throw new Error(`Invalid GlobalSettings: scope at index ${index} must be an object`);
    }
    if (!scope.id || typeof scope.id !== 'string') {
      throw new Error(`Invalid GlobalSettings: scope at index ${index} missing or invalid id`);
    }
    if (!scope.name || typeof scope.name !== 'string') {
      throw new Error(`Invalid GlobalSettings: scope at index ${index} missing or invalid name`);
    }
    if (!Array.isArray(scope.deviceIds)) {
      throw new Error(`Invalid GlobalSettings: scope at index ${index} deviceIds must be an array`);
    }
    scope.deviceIds.forEach((deviceId: string, deviceIndex: number) => {
      if (typeof deviceId !== 'string') {
        throw new Error(`Invalid GlobalSettings: scope ${scope.id} deviceIds[${deviceIndex}] must be a string`);
      }
    });
  });

  // Validate each role
  parsed.roles.forEach((role: any, index: number) => {
    if (!role || typeof role !== 'object') {
      throw new Error(`Invalid GlobalSettings: role at index ${index} must be an object`);
    }
    if (!role.id || typeof role.id !== 'string') {
      throw new Error(`Invalid GlobalSettings: role at index ${index} missing or invalid id`);
    }
    if (!role.name || typeof role.name !== 'string') {
      throw new Error(`Invalid GlobalSettings: role at index ${index} missing or invalid name`);
    }
  });

  // Validate each mapping
  parsed.mappings.forEach((mapping: any, index: number) => {
    if (!mapping || typeof mapping !== 'object') {
      throw new Error(`Invalid GlobalSettings: mapping at index ${index} must be an object`);
    }
    if (!mapping.id || typeof mapping.id !== 'string') {
      throw new Error(`Invalid GlobalSettings: mapping at index ${index} missing or invalid id`);
    }
    if (!mapping.scopeId || typeof mapping.scopeId !== 'string') {
      throw new Error(`Invalid GlobalSettings: mapping at index ${index} missing or invalid scopeId`);
    }
    if (!mapping.sourceProfile || typeof mapping.sourceProfile !== 'string') {
      throw new Error(`Invalid GlobalSettings: mapping at index ${index} missing or invalid sourceProfile`);
    }
    if (!mapping.targetProfile || typeof mapping.targetProfile !== 'string') {
      throw new Error(`Invalid GlobalSettings: mapping at index ${index} missing or invalid targetProfile`);
    }
    if (mapping.enabled !== undefined && typeof mapping.enabled !== 'boolean') {
      throw new Error(`Invalid GlobalSettings: mapping at index ${index} enabled must be boolean if present`);
    }
  });

  // Validate defaultActionSettings
  if (!parsed.defaultActionSettings || typeof parsed.defaultActionSettings !== 'object') {
    throw new Error('Invalid GlobalSettings: missing or invalid defaultActionSettings');
  }
  const def = parsed.defaultActionSettings;
  if (def.targetDeviceId !== undefined && typeof def.targetDeviceId !== 'string') {
    throw new Error('Invalid GlobalSettings: defaultActionSettings.targetDeviceId must be string if present');
  }
  if (def.targetProfile !== undefined && typeof def.targetProfile !== 'string') {
    throw new Error('Invalid GlobalSettings: defaultActionSettings.targetProfile must be string if present');
  }
  if (def.enabled !== undefined && typeof def.enabled !== 'boolean') {
    throw new Error('Invalid GlobalSettings: defaultActionSettings.enabled must be boolean if present');
  }

  // Cast to GlobalSettings (after validation)
  return parsed as GlobalSettings;
}

/**
 * Creates a default GlobalSettings instance
 */
export function createDefaultGlobalSettings(): GlobalSettings {
  return {
    version: '1.0.0',
    scopes: [
      {
        id: 'all',
        name: 'All Devices',
        deviceIds: [] // Empty means all devices
      }
    ],
    roles: [
      {
        id: 'primary',
        name: 'Primary Device',
        description: 'The device that triggers profile changes'
      },
      {
        id: 'secondary',
        name: 'Secondary Device',
        description: 'Devices that follow the primary device'
      }
    ],
    mappings: [
      {
        id: 'default-mapping',
        scopeId: 'all',
        sourceProfile: 'Default',
        targetProfile: 'Default',
        enabled: true
      }
    ],
    defaultActionSettings: {
      targetDeviceId: '',
      targetProfile: '',
      enabled: true
    }
  };
}