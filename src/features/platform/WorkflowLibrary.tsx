import { AudioLines, Box, FileText, GitBranch, Image, Search, Video, Workflow } from 'lucide-react';
import type { WorkflowCatalog, WorkflowTemplate } from './library';

export function WorkflowIcon({ category, size = 21 }: { category: string; size?: number }) {
  const icons: Record<string, typeof Image> = {
    image: Image,
    video: Video,
    audio: AudioLines,
    mesh: Box,
    text: FileText,
    composite: GitBranch,
  };
  const Icon = icons[category] ?? Workflow;
  return <Icon size={size} strokeWidth={1.7} />;
}

export function WorkflowLibrary({
  catalog,
  personal,
  category,
  query,
  onCategory,
  onQuery,
  onOpen,
  loading,
  error,
  onRetry,
}: {
  catalog: WorkflowCatalog | null;
  personal: WorkflowTemplate[];
  category: string;
  query: string;
  onCategory: (value: string) => void;
  onQuery: (value: string) => void;
  onOpen: (template: WorkflowTemplate, tab: 'inputs' | 'flow') => void;
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  const categories = [
    { id: 'all', label: '推荐工作流' },
    ...(catalog?.categories ?? []),
    { id: 'personal', label: '我的工作流' },
  ];
  const items = [...(catalog?.items ?? []), ...personal].filter(
    (item) =>
      (category === 'all' ||
        (category === 'personal' ? item.source === 'personal' : item.category === category)) &&
      `${item.title} ${item.description} ${item.input} ${item.output}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <div className="pfx-library-toolbar">
        <nav className="n-skill-tabs pfx-filters" aria-label="工作流分类">
          {categories.map((item) => (
            <button
              key={item.id}
              className={category === item.id ? 'active' : ''}
              aria-current={category === item.id ? 'page' : undefined}
              onClick={() => onCategory(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="n-catalog-toolbar pfx-library-search-row">
          <label className="n-search">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="搜索工作流"
              aria-label="搜索工作流"
            />
          </label>
        </div>
      </div>
      {error && (
        <div className="pfx-alert" role="alert">
          <span>工作流目录加载失败：{error}</span>
          <button className="pfx-secondary" disabled={loading} onClick={onRetry}>
            重新加载
          </button>
        </div>
      )}
      {loading && !catalog && (
        <div className="pfx-loading" role="status">
          正在获取工作流…
        </div>
      )}
      <div className="pfx-library-grid">
        {items.map((item) => (
          <article className="pfx-template" key={item.id}>
            <header>
              <span className="pfx-template-icon">
                <WorkflowIcon category={item.category} />
              </span>
              <div>
                <h2>{item.title}</h2>
                <small>
                  {item.source === 'personal'
                    ? '我的工作流'
                    : (categories.find((entry) => entry.id === item.category)?.label ??
                      item.category)}{' '}
                  · v{item.version}
                </small>
              </div>
            </header>
            <p className="pfx-template-description">{item.description}</p>
            <dl className="pfx-template-facts">
              <div>
                <dt>所需输入</dt>
                <dd>{item.input}</dd>
              </div>
              <div>
                <dt>生成产物</dt>
                <dd>{item.output}</dd>
              </div>
            </dl>
            <footer>
              <span>
                {item.source === 'personal' ? '我的工作流' : `${item.steps.length} 个步骤`}
              </span>
              <div>
                <button className="pfx-secondary" onClick={() => onOpen(item, 'flow')}>
                  查看流程
                </button>
                <button className="pfx-primary" onClick={() => onOpen(item, 'inputs')}>
                  {item.source === 'personal' ? '打开工作流' : '使用模板'}
                </button>
              </div>
            </footer>
          </article>
        ))}
      </div>
      {!loading && !items.length && (
        <div className="pfx-empty pfx-library-empty">
          <Workflow size={30} strokeWidth={1.4} />
          <h2>{category === 'personal' ? '还没有自己的工作流' : '没有找到匹配的工作流'}</h2>
          <p>
            {category === 'personal'
              ? '导入 ComfyUI JSON 文件，或新建一个工作流。'
              : '试试其他分类或关键词，也可以导入自己的工作流。'}
          </p>
          {query && (
            <button className="pfx-secondary" onClick={() => onQuery('')}>
              清除搜索
            </button>
          )}
        </div>
      )}
    </>
  );
}
