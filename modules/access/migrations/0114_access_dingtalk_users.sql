-- 钉钉工作台免登：一个钉钉 userid 对应一个成员账号，第一次从钉钉进来时建立。只存 userid，姓名在 access_members 里跟着钉钉更新。
CREATE TABLE access_dingtalk_users (
  userid     text PRIMARY KEY,
  member_id  integer NOT NULL UNIQUE REFERENCES access_members(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
