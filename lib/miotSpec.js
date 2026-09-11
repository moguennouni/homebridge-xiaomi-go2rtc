'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const SPEC_URL = 'https://miot-spec.org/miot-spec-v2';

// "urn:miot-spec-v2:property:motion-tracking:00000105:chuangmi-026c02:1" → "motion-tracking"
const urnName = (type) => (type || '').split(':')[3];

// Public MIoT specification of a model (services, properties, value lists), cached on disk
const loadSpec = async (model, cacheDir) => {
  const cacheFile = path.join(cacheDir, `miot-spec-${model}.json`);
  if (fs.existsSync(cacheFile)) {
    return JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
  }

  const instances = await (await fetch(`${SPEC_URL}/instances?status=released`)).json();
  const matches = (instances.instances || []).filter((instance) => instance.model === model);
  if (!matches.length) {
    return null;
  }
  const latest = matches.reduce((a, b) => (b.version > a.version ? b : a));

  const response = await fetch(`${SPEC_URL}/instance?type=${encodeURIComponent(latest.type)}`);
  if (!response.ok) {
    throw new Error(`miot-spec.org : ${response.status}`);
  }
  const spec = await response.json();
  await fsp.writeFile(cacheFile, JSON.stringify(spec));
  return spec;
};

const findProperty = (spec, serviceName, propertyName) => {
  for (const service of spec.services || []) {
    if (urnName(service.type) !== serviceName) {
      continue;
    }
    for (const property of service.properties || []) {
      if (urnName(property.type) === propertyName && (property.access || []).includes('write')) {
        return { siid: service.iid, piid: property.iid, property };
      }
    }
  }
  return null;
};

const valueFor = (property, description) => {
  const entry = (property['value-list'] || []).find((item) => item.description.toLowerCase() === description);
  return entry ? entry.value : undefined;
};

// Settings exposed as HomeKit switches, when the model has them
const CONTROLS = [
  {
    id: 'standby', name: 'Veille', service: 'camera-control', property: 'on',
    toHomeKit: (value) => value === false, toXiaomi: (on) => !on,
  },
  {
    id: 'indicator', name: 'Voyant', service: 'indicator-light', property: 'on',
    toHomeKit: (value) => value === true, toXiaomi: (on) => on,
  },
  {
    id: 'tracking', name: 'Suivi des mouvements', service: 'camera-control', property: 'motion-tracking',
    toHomeKit: (value) => value === true, toXiaomi: (on) => on,
  },
  {
    id: 'detection', name: 'Détection de mouvement', service: 'motion-detection', property: 'motion-detection',
    toHomeKit: (value) => value === true, toXiaomi: (on) => on,
  },
  {
    // Values: On (forced) / Off / Auto. The switch toggles between Auto and Off.
    id: 'night', name: 'Vision nocturne', service: 'camera-control', property: 'night-shot',
    prepare: (property) => {
      const off = valueFor(property, 'off');
      const auto = valueFor(property, 'auto');
      if (off === undefined || auto === undefined) {
        return null;
      }
      return { toHomeKit: (value) => value !== off, toXiaomi: (on) => (on ? auto : off) };
    },
  },
];

const availableControls = (spec) => {
  const controls = [];
  for (const control of CONTROLS) {
    const found = findProperty(spec, control.service, control.property);
    if (!found) {
      continue;
    }
    const converters = control.prepare ? control.prepare(found.property) : control;
    if (!converters) {
      continue;
    }
    controls.push({
      id: control.id,
      name: control.name,
      siid: found.siid,
      piid: found.piid,
      toHomeKit: converters.toHomeKit,
      toXiaomi: converters.toXiaomi,
    });
  }
  return controls;
};

module.exports = { loadSpec, availableControls };
