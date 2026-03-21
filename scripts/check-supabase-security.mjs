import {
  AUTHENTICATED_DML_OBJECT_GRANTS,
  AUTHENTICATED_SELECT_ONLY_OBJECTS,
  INTERNAL_NO_GRANT_OBJECTS,
  PHASE1_PRIVATE_TABLES,
  PUBLIC_FUNCTION_EXECUTE_ALLOWLIST,
  PUBLIC_SCHEMA_EVENT_TRIGGER,
  PUBLIC_SELECT_ONLY_OBJECTS,
  PUBLIC_VIEW_NAMES,
  RLS_EXEMPT_PUBLIC_TABLES,
  RLS_REQUIRED_PUBLIC_TABLES,
  SEQUENCE_GRANT_CONTRACTS,
  SECURITY_INVOKER_VIEWS,
  WRITE_ONLY_PUBLIC_OBJECT_GRANTS,
} from "./security-guardrails.config.mjs";
import { runLinkedDbQuery } from "./lib/linked-db.mjs";

const failures = [];
const RLS_REQUIRED = new Set(RLS_REQUIRED_PUBLIC_TABLES);
const RLS_EXEMPT = new Set(RLS_EXEMPT_PUBLIC_TABLES);
const PUBLIC_VIEWS = new Set(PUBLIC_VIEW_NAMES);
const SECURITY_INVOKER_REQUIRED = new Set(SECURITY_INVOKER_VIEWS);
const PHASE1_PRIVATE = new Set(PHASE1_PRIVATE_TABLES);

function addFailure(section, message) {
  failures.push({ section, message });
}

function formatList(values) {
  return values.length === 0 ? "(none)" : values.join(", ");
}

function sameValues(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function normalizePrivileges(values) {
  return [...new Set(values)].sort();
}

function normalizeTextArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }

  if (value && typeof value === "object" && Array.isArray(value.Elements)) {
    return value.Elements.map((entry) => String(entry));
  }

  return [];
}

function buildGrantContracts() {
  const contracts = new Map();

  function register(name, spec) {
    if (contracts.has(name)) {
      throw new Error(`Duplicate grant contract classification for ${name}`);
    }
    contracts.set(name, spec);
  }

  for (const objectName of PUBLIC_SELECT_ONLY_OBJECTS) {
    register(objectName, {
      anon: ["SELECT"],
      authenticated: ["SELECT"],
    });
  }

  for (const objectName of AUTHENTICATED_SELECT_ONLY_OBJECTS) {
    register(objectName, {
      anon: [],
      authenticated: ["SELECT"],
    });
  }

  for (const [objectName, privileges] of Object.entries(AUTHENTICATED_DML_OBJECT_GRANTS)) {
    register(objectName, {
      anon: [],
      authenticated: privileges,
    });
  }

  for (const [objectName, privileges] of Object.entries(WRITE_ONLY_PUBLIC_OBJECT_GRANTS)) {
    register(objectName, {
      anon: privileges,
      authenticated: privileges,
    });
  }

  for (const objectName of INTERNAL_NO_GRANT_OBJECTS) {
    register(objectName, {
      anon: [],
      authenticated: [],
    });
  }

  return contracts;
}

const GRANT_CONTRACTS = buildGrantContracts();

const publicTables = runLinkedDbQuery(
  `
  select tablename, rowsecurity
  from pg_tables
  where schemaname = 'public'
  order by tablename;
  `,
  { label: "public tables" },
);

const publicViews = runLinkedDbQuery(
  `
  select c.relname as view_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'v'
    and n.nspname = 'public'
  order by c.relname;
  `,
  { label: "public views" },
);

const publicSequences = runLinkedDbQuery(
  `
  with sequences as (
    select
      seq.oid,
      seq.relname as sequence_name,
      tbl.relname as owning_table,
      col.attname as owning_column
    from pg_class seq
    join pg_namespace seq_ns on seq_ns.oid = seq.relnamespace
    left join pg_depend dep
      on dep.objid = seq.oid
     and dep.deptype = 'a'
    left join pg_class tbl on tbl.oid = dep.refobjid
    left join pg_attribute col
      on col.attrelid = tbl.oid
     and col.attnum = dep.refobjsubid
    where seq.relkind = 'S'
      and seq_ns.nspname = 'public'
  )
  select
    sequence_name,
    owning_table,
    owning_column,
    jsonb_build_object(
      'anon',
      jsonb_build_object(
        'USAGE', has_sequence_privilege('anon', oid, 'USAGE'),
        'SELECT', has_sequence_privilege('anon', oid, 'SELECT'),
        'UPDATE', has_sequence_privilege('anon', oid, 'UPDATE')
      ),
      'authenticated',
      jsonb_build_object(
        'USAGE', has_sequence_privilege('authenticated', oid, 'USAGE'),
        'SELECT', has_sequence_privilege('authenticated', oid, 'SELECT'),
        'UPDATE', has_sequence_privilege('authenticated', oid, 'UPDATE')
      )
    ) as privileges
  from sequences
  order by sequence_name;
  `,
  { label: "public sequences" },
);

const objectGrants = runLinkedDbQuery(
  `
  select table_name as object_name, grantee, privilege_type
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
  order by table_name, grantee, privilege_type;
  `,
  { label: "public object grants" },
);

const publicFunctions = runLinkedDbQuery(
  `
  with app_functions as (
    select
      p.oid,
      p.oid::regprocedure::text as signature,
      p.proname as function_name,
      p.prosecdef as security_definer,
      coalesce(p.proconfig, '{}'::text[]) as proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join pg_depend d
      on d.classid = 'pg_proc'::regclass
     and d.objid = p.oid
     and d.deptype = 'e'
    where n.nspname = 'public'
      and d.objid is null
  )
  select
    signature,
    function_name,
    security_definer,
    proconfig,
    jsonb_strip_nulls(
      jsonb_build_object(
        'anon', case when has_function_privilege('anon', oid, 'EXECUTE') then true else null end,
        'authenticated', case when has_function_privilege('authenticated', oid, 'EXECUTE') then true else null end
      )
    ) as exposed_roles
  from app_functions
  order by signature;
  `,
  { label: "public functions" },
);

const viewOptions = runLinkedDbQuery(
  `
  select
    c.relname as view_name,
    coalesce(c.reloptions, '{}'::text[]) as reloptions
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'v'
    and n.nspname = 'public'
  order by c.relname;
  `,
  { label: "public view options" },
);

const eventTriggers = runLinkedDbQuery(
  `
  select evtname
  from pg_event_trigger
  order by evtname;
  `,
  { label: "event triggers" },
);

for (const table of publicTables) {
  const { tablename, rowsecurity } = table;
  const requiresRls = RLS_REQUIRED.has(tablename);
  const exemptFromRls = RLS_EXEMPT.has(tablename);

  if (requiresRls && exemptFromRls) {
    addFailure("config", `${tablename} is listed in both RLS required and RLS exempt sets.`);
    continue;
  }

  if (!requiresRls && !exemptFromRls) {
    addFailure("rls-coverage", `${tablename} is a public-schema table without an explicit RLS classification.`);
    continue;
  }

  if (requiresRls && rowsecurity !== true) {
    addFailure("rls-state", `${tablename} must have row security enabled.`);
  }
}

const tableNames = new Set(publicTables.map((row) => row.tablename));
for (const tablename of [...RLS_REQUIRED, ...RLS_EXEMPT]) {
  if (!tableNames.has(tablename)) {
    addFailure("config", `${tablename} is listed in the RLS contract but does not exist in schema public.`);
  }
}

const viewNames = new Set(publicViews.map((row) => row.view_name));
for (const viewName of viewNames) {
  if (!PUBLIC_VIEWS.has(viewName)) {
    addFailure("view-coverage", `${viewName} is a public-schema view without an explicit contract classification.`);
  }
}
for (const viewName of PUBLIC_VIEWS) {
  if (!viewNames.has(viewName)) {
    addFailure("config", `${viewName} is listed in PUBLIC_VIEW_NAMES but does not exist in schema public.`);
  }
}

const actualGrantMatrix = new Map();
for (const row of objectGrants) {
  const objectName = row.object_name;
  const role = row.grantee;
  const privilege = row.privilege_type;

  let objectEntry = actualGrantMatrix.get(objectName);
  if (!objectEntry) {
    objectEntry = new Map([
      ["anon", []],
      ["authenticated", []],
    ]);
    actualGrantMatrix.set(objectName, objectEntry);
  }

  objectEntry.get(role).push(privilege);
}

const classifiedObjects = new Set(GRANT_CONTRACTS.keys());
const knownObjects = new Set([...tableNames, ...viewNames]);

for (const objectName of knownObjects) {
  if (!classifiedObjects.has(objectName)) {
    addFailure("grant-coverage", `${objectName} does not have an explicit anon/authenticated grant contract.`);
  }
}

for (const objectName of classifiedObjects) {
  if (!knownObjects.has(objectName)) {
    addFailure("config", `${objectName} is listed in the grant contract but does not exist in schema public.`);
  }
}

for (const objectName of knownObjects) {
  const expected = GRANT_CONTRACTS.get(objectName) ?? { anon: [], authenticated: [] };
  const actual = actualGrantMatrix.get(objectName) ?? new Map([
    ["anon", []],
    ["authenticated", []],
  ]);

  for (const role of ["anon", "authenticated"]) {
    const expectedPrivileges = normalizePrivileges(expected[role] ?? []);
    const actualPrivileges = normalizePrivileges(actual.get(role) ?? []);

    if (!sameValues(actualPrivileges, expectedPrivileges)) {
      addFailure(
        "grant-contract",
        `${objectName} has ${role} grants [${formatList(actualPrivileges)}] but expected [${formatList(expectedPrivileges)}].`,
      );
    }
  }
}

for (const tableName of PHASE1_PRIVATE) {
  const actual = actualGrantMatrix.get(tableName) ?? new Map([
    ["anon", []],
    ["authenticated", []],
  ]);
  const anonPrivileges = normalizePrivileges(actual.get("anon") ?? []);
  if (anonPrivileges.length > 0) {
    addFailure("phase1-privacy", `${tableName} leaked anon grants [${formatList(anonPrivileges)}].`);
  }
}

const sequenceNames = new Set(publicSequences.map((row) => row.sequence_name));
const classifiedSequences = new Set(Object.keys(SEQUENCE_GRANT_CONTRACTS));

for (const sequenceName of sequenceNames) {
  if (!classifiedSequences.has(sequenceName)) {
    addFailure("sequence-coverage", `${sequenceName} is a public-schema sequence without an explicit privilege contract.`);
  }
}

for (const sequenceName of classifiedSequences) {
  if (!sequenceNames.has(sequenceName)) {
    addFailure("config", `${sequenceName} is listed in the sequence contract but does not exist in schema public.`);
  }
}

for (const row of publicSequences) {
  const expected = SEQUENCE_GRANT_CONTRACTS[row.sequence_name];
  if (!expected) continue;

  for (const role of ["anon", "authenticated"]) {
    const rolePrivileges = row.privileges?.[role] ?? {};
    const actualPrivileges = normalizePrivileges(
      Object.entries(rolePrivileges)
        .filter(([, granted]) => granted === true)
        .map(([privilege]) => privilege),
    );
    const expectedPrivileges = normalizePrivileges(expected[role] ?? []);

    if (!sameValues(actualPrivileges, expectedPrivileges)) {
      const ownership = row.owning_table
        ? ` backs ${row.owning_table}${row.owning_column ? `.${row.owning_column}` : ""}`
        : "";
      addFailure(
        "sequence-contract",
        `${row.sequence_name}${ownership} has ${role} sequence privileges [${formatList(actualPrivileges)}] but expected [${formatList(expectedPrivileges)}].`,
      );
    }
  }
}

const actualFunctionContracts = new Map();
for (const row of publicFunctions) {
  const signature = row.signature;
  const exposedRoles = Object.keys(row.exposed_roles ?? {}).sort();
  actualFunctionContracts.set(signature, {
    exposedRoles,
    securityDefiner: row.security_definer === true,
    proconfig: normalizeTextArray(row.proconfig),
  });
}

for (const [signature, contract] of actualFunctionContracts) {
  const expectedRoles = normalizePrivileges(PUBLIC_FUNCTION_EXECUTE_ALLOWLIST[signature] ?? []);

  if (!sameValues(contract.exposedRoles, expectedRoles)) {
    addFailure(
      "function-execute",
      `${signature} exposes [${formatList(contract.exposedRoles)}] but expected [${formatList(expectedRoles)}].`,
    );
  }

  if (contract.securityDefiner) {
    const hasPinnedSearchPath = contract.proconfig.some((setting) => setting.startsWith("search_path="));
    if (!hasPinnedSearchPath) {
      addFailure("function-hardening", `${signature} is SECURITY DEFINER without a pinned search_path.`);
    }
  }
}

for (const signature of Object.keys(PUBLIC_FUNCTION_EXECUTE_ALLOWLIST)) {
  if (!actualFunctionContracts.has(signature)) {
    addFailure("config", `${signature} is listed in the function allowlist but does not exist in schema public.`);
  }
}

const viewOptionMap = new Map(
  viewOptions.map((row) => [row.view_name, normalizeTextArray(row.reloptions)]),
);

for (const viewName of SECURITY_INVOKER_REQUIRED) {
  const options = viewOptionMap.get(viewName);
  if (!options) {
    addFailure("view-options", `${viewName} is missing from the public view options query.`);
    continue;
  }

  if (!options.includes("security_invoker=true")) {
    addFailure("view-options", `${viewName} must retain security_invoker=true.`);
  }
}

const eventTriggerNames = new Set(eventTriggers.map((row) => row.evtname));
if (!eventTriggerNames.has(PUBLIC_SCHEMA_EVENT_TRIGGER)) {
  addFailure("rls-guardrail", `Event trigger ${PUBLIC_SCHEMA_EVENT_TRIGGER} is missing.`);
}

if (failures.length > 0) {
  console.error("Supabase security contract FAILED:");

  const sections = new Map();
  for (const failure of failures) {
    const bucket = sections.get(failure.section) ?? [];
    bucket.push(failure.message);
    sections.set(failure.section, bucket);
  }

  for (const [section, messages] of sections) {
    console.error(`\n[${section}]`);
    for (const message of messages) {
      console.error(`  - ${message}`);
    }
  }

  console.error(
    "\nFix the migration or contract config, then rerun `npm run check:security:schema` against the linked Supabase project.",
  );
  process.exit(1);
}

console.log("Supabase security contract passed.");
