import { useEffect, useState } from 'react';
import { downloadWorkflowExampleImage } from './api';
import { workflowExamples } from './library';

function ExampleImage({ path, label }: { path: string; label: string }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    setUrl('');
    setFailed(false);
    void downloadWorkflowExampleImage(path).then(value => {
      if (cancelled) URL.revokeObjectURL(value);
      else { objectUrl = value; setUrl(value); }
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path]);
  return <figure><figcaption>{label}</figcaption>{url ? <img src={url} alt={label} /> : <span>{failed ? '图片暂不可用' : '图片加载中…'}</span>}</figure>;
}

export function WorkflowExamples({ value, onUsePrompt }: { value: unknown; onUsePrompt?: (prompt: string) => void }) {
  const examples = workflowExamples(value);
  const [open, setOpen] = useState<number | null>(null);
  if (!examples.length) return null;
  return <section className="pfx-examples" aria-label="使用案例">
    <div className="pfx-examples-heading"><h2>使用案例</h2><p>看看其他场景如何准备输入和描述，再试试自己的创意。</p></div>
    {examples.map((example, index) => <article className="pfx-example" key={`${index}-${example.title}`}>
      <button type="button" className="pfx-example-toggle" aria-expanded={open === index} onClick={() => setOpen(open === index ? null : index)}>
        <span>{example.title}</span><span aria-hidden="true">{open === index ? '−' : '+'}</span>
      </button>
      {open === index && <div className="pfx-example-body">
        {example.description && <p>{example.description}</p>}
        {(example.inputImage || example.resultImage) && <div className="pfx-example-images">
          {example.inputImage && <ExampleImage path={example.inputImage} label="示例输入" />}
          {example.resultImage && <ExampleImage path={example.resultImage} label="示例结果" />}
        </div>}
        {!!example.steps?.length && <ol>{example.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>}
        {example.prompt && <div className="pfx-example-prompt"><strong>示例提示词</strong><p>{example.prompt}</p>{onUsePrompt && <button type="button" className="pfx-secondary" onClick={() => onUsePrompt(example.prompt!)}>使用这段提示词</button>}</div>}
      </div>}
    </article>)}
  </section>;
}
