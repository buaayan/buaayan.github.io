---
title: 手把手完成JobSystem-Part3无锁队列
date: 2024-09-02 20:01:33
tags:
---

## Job System 2.0: Lock-Free Work Stealing – Part 3: Going lock-free
本文翻译自1部分模块添加自己的理解，有兴趣的同学建议阅读原文。将探索job system的核心问题：实现一个无锁实现的任务偷取队列。

## 回顾
记住任务偷取队列需要提供的三个操作：
* Push(): 在队列私有端添加job(LIFO)
* Pop(): 在队列的私有端移除job(LIFO)
* Steal(): 从队列公有端偷取job(FIFO)

进一步需要记住Push()和Pop()只能在拥有线程调用不会出现并行问题。Steal()可以被其他线程调用，在任意时间点，都可能和Push()和Pop()并行调用。

## 带锁的实现版本
在探索无锁编程之前，我们先用常规锁实现一版。从概念上明确如何构造一个双端队列，一端表现为LIFO，另一端表现为FIFO。

我们可以通过维护两套序号来解决这个问题，如果我们假设有无限内存，创建两个计数器（bottom和top）：

* bottom表示下一个job将会push到数组中下一个序号位置内，Push操作首先储存job，然后自增bottom。
* 类似的，Pop会自减bottom，然后返回所在数组位置的job。
* top定义了下一个可以被偷取的元素（也就是说最顶端），Steal()接口调用后，会从当前位置获取一个job，并且自增top。

可以看出，在任何时间点，bottom-top的数值都是当前在双向队列中的工作数，如果bottom>=top，队列中是空的，没有可供偷取的job。另一方面，Push和Pop只更改bottom，Steal只更改top，这一点非常重要，最小化窃取工作的同步开销，并且非常有利于无锁实现。

为了更好的展示双向队列如何工作，下表展示不同操作在队列上的表现：
| 操作 | bottom | top | size(bottom-top) |
| ---- | ---- | ---- | ---- |
| Empty | 0 | 0 | 0 |
| Push | 1 | 0 | 1 |
| Push | 2 | 0 | 2 |
| Push | 3 | 0 | 3 |
| Steal | 3 | 1 | 2 |
| Pop | 2 | 1 | 1 |
| Pop | 1 | 1 | 0 |

如前文所说，Push()和Pop()以LIFO方式工作，Steal()以FIFO方式工作。在上述例子中，Steal()返回的是序号0的job，Pop()依次返回的是序号2和序号1的job。三种操作示例代码如下：

```
void Push(Job* job)
{
    ScopedLock lock(criticalSection);

    m_jobs[m_bottom] = job;
    ++m_bottom;
}

Job* Pop(void)
{
    ScopedLock lock(criticalSection);

    const int jobCount = m_bottom - m_top;
    if (jobCount <= 0)
    {
        // no job left in the queue
        return nullptr;
    }

    --m_bottom;
    return m_jobs[m_bottom];
}

Job* Steal(void)
{
    ScopedLock lock(criticalSection);

    const int jobCount = m_bottom - m_top;
    if (jobCount <= 0)
    {
        // no job there to steal
        return nullptr;
    }

    Job* job = m_jobs[m_top];
    ++m_top;
    return job;
}
```

现在需要把无限制的计数器加上边界，使其变成循环数组。通过对bottom和top取模操作实现。但这样job数量会不好计算，需要考虑到取模的情况，更好的方案是在访问数组时在bottom和top上应用取模操作。只要数组数长度数量是2的次方，只是多了一次按位与操作。

```
static const unsigned int UNMBER_OF_JOBS = 4096u;
static const unsigned int MASK = UNMBER_OF_JOBS - 1u;

void Push(Job* job)
{
    ScopedLock lock(criticalSection);

    m_jobs[m_bottom & MASK] = job;
    ++m_bottom;
}

Job* Pop(void)
{
    ScopedLock lock(criticalSection);

    const int jobCount = m_bottom - m_top;
    if (jobCount <= 0)
    {
        // no job left in the queue
        return nullptr;
    }

    --m_bottom;
    return m_jobs[m_bottom & MASK];
}

Job* Steal(void)
{
    ScopedLock lock(criticalSection);

    const int jobCount = m_bottom - m_top;
    if (jobCount <= 0)
    {
        // no job there to steal
        return nullptr;
    }

    Job* job = m_jobs[m_top & MASK];
    ++m_top;
    return job;
}
```

目前为止，我们实现了一个使用传统锁的工作偷取队列。

## 必要知识：无锁编程
无锁编程是一个巨大的课题，已经有很多文章介绍。从中提取出几篇质量较高的文章，推荐在下一章节开发前阅读：

* 无锁编程简介3: 课程包含原子操作、顺序一致性和内存顺序，“无锁编程101”必读课程。
* 编译时内存顺序4: 介绍编译器重排序和内存界限。
* 实践中的内存重排序5: 介绍在x86/64下发生内存重排序的粒子，即使是intel x86/64架构提供强内存模型。
* Weak vs. Strong Memory Models5: 讨论强和弱内存模型，以及连续一致性。
* Jeff Preshing的blgo是无锁编程的金框，如果有所疑问，查查他的blog。
无锁工作偷取队列

假设没有编译器重排序，绝对没有内存重排序的问题。实现一版队列函数：

```
void Push(Job* job)
{
    long b = m_bottom;
    m_jobs[b & MASK] = job;
    m_bottom = b+1;
}
```

当其他操作并行发生时会出现什么问题？Pop()无法并行调用，我们只需考虑Steal(),Steal()只写入top读取bottom。所以可能出错的情况是：Push()过程中（在#5行m_bottom自增之前）调用Steal()，认为队列为空。不用担心这件事情，因为只会造成调用Steal()偷取不到工作，不会实质性的伤害。

Steal()实现变为：

```
Job* Steal(void)
{
    long t = m_top;
    long b = m_bottom;
    if (t < b)
    {
        // non-empty queue
        Job* job = m_jobs[t & MASK];

        if (_InterlockedCompareExchange(&m_top, t+1, t) != t)
        {
            // a concurrent steal or pop operation removed an element from the deque in the meantime.
            return nullptr;
        }

        return job;
    }
    else
    {
        // empty queue
        return nullptr;
    }
}
```

只要top < bottom，表明队列中仍然有job可以获取。如果队列不为空，这个函数首先获取数组中的job，然后使用compare-and-swap6操作自增top。如果CAS失败，Steal()成功从队列中获取一个job。

需要注意：必须在CAS操作之前读取job，因为数组中的位置可能被在CAS操作之后并行调用的Push() 改写。

必须要确保top读取在bottom读取之前，保证数值与当前内存的一致性。现在仍然有可能会发生数据竞争：在bottom读取出来后CAS调用之前，如果此时调用Pop()导致队列变为空队列，那么返回的job会有问题。我们需要保Pop()和Steal()不会同时返回队列中的最后一个job，下面在Pop()中通过CAS更改top:

```
Job* Pop(void)
{
    long b = m_bottom - 1;
    m_bottom = b;

    long t = m_top;
    if (t <= b)
    {
        // non-empty queue
        Job* job = m_jobs[b & MASK];
        if (t != b)
        {
            // there's still more than one item left in the queue
            return job;
        }

        // this is the last item in the queue
        if (_InterlockedCompareExchange(&m_top, t+1, t) != t)
        {
            // failed race against steal operation
            job = nullptr;
        }

        m_bottom = t+1;
        return job;
    }
    else
    {
        // deque was already empty
        m_bottom = t;
        return nullptr;
    }
}
```

和Steal()中对比，这里必须确保bottom自增在读取top之前，否则，Steal()能够在Pop()不感知的情况下偷走job。另外，如果队列空了我们必须显式指定bottom = top。

如上讨论，只要队列中还有job，我们可以我们直接返回而无需进行多余的原子操作。只是在最后一个job时候需要考虑Steal()的并行问题。

上述代码使用CAS操作增加top并且检查赢得或者失去一次和Steal()的竞争，可能出现两个结果：
* 获得CAS竞争（对比Steal()），设定bottom = t + 1，设定队列为空的状态。
* 输掉CAS竞争（对比Steal()）,返回一个空job，仍然设定bottom = t + 1，因为输给Steal()会把top设定为t + 1,所以我们依然需要将队列置成空状态。

## 添加编译和内存隔离
迄今为止，上述代码不能按照我们的预期执行，因为没有考虑编译和内存隔离问题，这一点需要被修复。

再看下Push()的实现：

```
void Push(Job* job)
{
    long b = m_bottom;
    m_jobs[b & MASK] = job;
    m_bottom = b+1;
}
```

没人能保证编译器不会重新排序上述代码指令，尤其是，我们无法保证在队列中存储早与自增bottom（其他线程关注的变量），如果其他线程偷取了实际还没有存入队列的job。我们需要添加编译隔离：

```
void Push(Job* job)
{
    long b = m_bottom;
    m_jobs[b & MASK] = job;

    // ensure the job is written before b+1 is published to other threads.
    // on x86/64, a compiler barrier is enough.
    COMPILER_BARRIER;

    m_bottom = b+1;
}
```

因为强内存顺序下，不允许存储指令被重排序到另一个存储之前，所以x86/64下仅编译隔离是够用的。在其他平台上（PowerPC,ARM,...），需要使用memory fence。更进一步来讲，存储操作并不需要保证原子性，因为另一个对bottom进行操作的是Pop()，不可能并行调用。

相似的，我们同样需要在Steal()中实现编译隔离：

```
Job* Steal(void)
{
    long t = m_top;

    // ensure that top is always read before bottom.
    // loads will not be reordered with other loads on x86, so a compiler barrier is enough.
    COMPILER_BARRIER;

    long b = m_bottom;
    if (t < b)
    {
        // non-empty queue
        Job* job = m_jobs[t & MASK];

        // the interlocked function serves as a compiler barrier, and guarantees that the read happens before the CAS.
        if (_InterlockedCompareExchange(&m_top, t+1, t) != t)
        {
            // a concurrent steal or pop operation removed an element from the deque in the meantime.
            return nullptr;
        }

        return job;
    }
    else
    {
        // empty queue
        return nullptr;
    }
}
``` 
这里我们需要一个编译隔离来保证top的读取实际发生在bottom之前。另外，我们需要另一个隔离来保证在CAS执行之前工作从数组中取出。这个情况下，CAS操作同时也作为一个内存隔离。

Pop()改造：

```
Job* Pop(void)
{
    long b = m_bottom - 1;
    m_bottom = b;

    long t = m_top;
    if (t <= b)
    {
        // non-empty queue
        Job* job = m_jobs[b & MASK];
        if (t != b)
        {
            // there's still more than one item left in the queue
            return job;
        }

        // this is the last item in the queue
        if (_InterlockedCompareExchange(&m_top, t+1, t) != t)
        {
            // failed race against steal operation
            job = nullptr;
        }

        m_bottom = t+1;
        return job;
    }
    else
    {
        // deque was already empty
        m_bottom = t;
        return nullptr;
    }
}
```

最重要的实现是头三行代码，这是一个真正需要内存隔离的地方，即便是在x86/64架构上。这三行代码里，存储操作bottom = b和读取操作long t = top之间添加内存隔离并不足够，因为内存模型明确允许这种情况：读取和其他位置的写入允许被重排序。头几行代码变为：

```
long b = m_bottom - 1;
m_bottom = b;

MEMORY_BARRIER;

long t = m_top;
```

SFENCE和LFENCE7在这种情况下都不满足，需要一个MFENCE隔离。我们可以取代锁，使用内在带锁操作（例如XCHG），在这种情况下性能更好：

```
long b = m_bottom - 1;
_InterlockedExchange(&m_bottom, b);

long t = m_top;
```

剩下Pop()可以保持不变，类似于Steal()，CAS操作作为一个编译器隔离，bottom = t + 1并不需要原子操作，因为bottom并不会出现并行操作。

| 性能 | 基本 | 线程独占 | 无锁队列 | 第一版对比提升 | 第二版对比提升 |
| ---- | ---- | ---- | ---- | ---- | ---- |
| 单任务 | 9.9ms | 2.93ms | 6.31x | 3.38x |
| 并行任务 | 5.3ms | 0.76ms | 6.97x | 1.78x |

对比第一版实现，无锁版本和线程独占带来了7倍左右的收益，对比线程独占版本，我们依然提速了1.8x和3.3x版本。

## 参考
[1] https://blog.molecular-matters.com/2015/09/25/job-system-2-0-lock-free-work-stealing-part-3-going-lock-free/

[2] http://neteril.org/~jeremie/Dynamic_Circular_Work_Queue.pdf

[3] http://preshing.com/20120612/an-introduction-to-lock-free-programming/

[4]http://preshing.com/20120625/memory-ordering-at-compile-time/

[5]https://preshing.com/20120515/memory-reordering-caught-in-the-act/

[6]https://docs.microsoft.com/zh-cn/windows/win32/api/winnt/nf-winnt-interlockedcompareexchange?redirectedfrom=MSDN

[7]https://blog.csdn.net/admiral_j/article/details/8072855