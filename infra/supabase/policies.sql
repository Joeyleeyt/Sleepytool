-- Row-level security: each owner can only see their own projects + descendants.
-- Apply after Drizzle migrations have created the tables.

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_owner_select ON projects FOR SELECT USING (owner_id = auth.uid());
CREATE POLICY projects_owner_modify ON projects FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- Descendants gate by project ownership
CREATE OR REPLACE FUNCTION owns_project(p uuid) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM projects WHERE id = p AND owner_id = auth.uid());
$$ LANGUAGE sql STABLE;

ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
CREATE POLICY transcripts_owner ON transcripts FOR ALL USING (owns_project(project_id)) WITH CHECK (owns_project(project_id));

ALTER TABLE scenes ENABLE ROW LEVEL SECURITY;
CREATE POLICY scenes_owner ON scenes FOR ALL USING (owns_project(project_id)) WITH CHECK (owns_project(project_id));

ALTER TABLE shots ENABLE ROW LEVEL SECURITY;
CREATE POLICY shots_owner ON shots FOR ALL USING (owns_project(project_id)) WITH CHECK (owns_project(project_id));

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY assets_owner ON assets FOR ALL USING (owns_project(project_id)) WITH CHECK (owns_project(project_id));

ALTER TABLE timelines ENABLE ROW LEVEL SECURITY;
CREATE POLICY timelines_owner ON timelines FOR ALL USING (owns_project(project_id)) WITH CHECK (owns_project(project_id));

ALTER TABLE renders ENABLE ROW LEVEL SECURITY;
CREATE POLICY renders_owner ON renders FOR ALL USING (owns_project(project_id)) WITH CHECK (owns_project(project_id));

ALTER TABLE visual_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY vm_owner ON visual_memory FOR ALL USING (owns_project(project_id)) WITH CHECK (owns_project(project_id));

ALTER TABLE project_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_owner ON project_events FOR SELECT USING (owns_project(project_id));
